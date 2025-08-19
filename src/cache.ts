import * as core from "@actions/core";
import { exec, PromiseWithChild } from "child_process";
import fg from "fast-glob";
import filenamify from "filenamify";
import fs from "fs";
import { basename, dirname, join } from "path";
import prettyBytes from "pretty-bytes";
import { promisify } from "util";

const execAsync = promisify(exec);

export class ReserveCacheError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReserveCacheError";
        Object.setPrototypeOf(this, ReserveCacheError.prototype);
    }
}

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}

function checkPaths(paths: string[]): void {
    if (!paths || paths.length === 0) {
        throw new ValidationError(
            `Path Validation Error: At least one directory or file path is required`
        );
    }
}

function checkKey(key: string): void {
    if (key.length > 255) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot be larger than 255 characters.`
        );
    }
    const regex = /^[^,]*$/;
    if (!regex.test(key)) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot contain commas.`
        );
    }
}

async function streamOutputUntilResolved(
    promise: PromiseWithChild<unknown>
): Promise<unknown> {
    const { child } = promise;
    const { stdout, stderr } = child;

    if (stdout) {
        stdout.on("data", data => {
            core.info(data.trim());
        });
    }

    if (stderr) {
        stderr.on("data", data => {
            if (!data) {
                return;
            }
            core.warning(data.trim());
        });
    }

    return promise;
}

function filterCacheFiles(
    filenameMatchers,
    cacheFiles: fg.Entry[]
): { key: string | null; potentialCaches: fg.Entry[] } {
    const potentialCaches: fg.Entry[] = [];
    for (const filenameMatcher of filenameMatchers) {
        for (const cacheFile of cacheFiles) {
            if (cacheFile.name.indexOf(filenameMatcher) !== -1) {
                potentialCaches.push(cacheFile);
            }
        }
        if (potentialCaches.length) {
            return { key: filenameMatcher, potentialCaches };
        }
    }
    return { key: null, potentialCaches };
}

function locateCacheFile(
    filenameMatchers,
    cacheFiles: fg.Entry[]
): { key: string; cacheFile: fg.Entry } | null {
    const { key, potentialCaches } = filterCacheFiles(
        filenameMatchers,
        cacheFiles
    );

    if (!potentialCaches.length || !key) {
        return null;
    }

    const latestCacheFile = potentialCaches
        .sort((a, b) => {
            const mtimeA = a.stats?.mtimeMs || 0;
            const mtimeB = b.stats?.mtimeMs || 0;

            return mtimeA > mtimeB ? 1 : mtimeB > mtimeA ? -1 : 0;
        })
        .pop();

    // console.log({ potentialCaches, latestCacheFile });

    if (!latestCacheFile) {
        return null;
    }

    return { key, cacheFile: latestCacheFile };
}

function getCacheDirPath(): string {
    return join(
        process.env.CACHE_DIR || `/media/cache/`,
        process.env.GITHUB_REPOSITORY || ""
    );
}

/**
 * Restores cache from keys
 *
 * @param paths a list of file paths to restore from the cache
 * @param primaryKey an explicit key for restoring the cache
 * @param restoreKeys an optional ordered list of keys to use for restoring the cache if no cache hit occurred for key
 * @returns string returns the key for the cache hit, otherwise returns undefined
 */
export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[]
): Promise<string | undefined> {
    checkKey(primaryKey);
    checkPaths(paths);
    
    // DEBUG: Show all paths received
    core.info(`🔍 DEBUG - All paths received for restore:`);
    paths.forEach((p, i) => core.info(`  [${i}]: ${p}`));
    core.info(`⚠️  WARNING - Only processing first path: ${paths[0]}`);
    core.info(`❌ IGNORED - ${paths.length - 1} other path(s): ${paths.slice(1).join(', ')}`);
    
    const path = paths[0];

    const cacheDir = getCacheDirPath();

    // 1. check if we find any dir that matches our keys from restoreKeys
    const filenameMatchers = (
        Array.isArray(restoreKeys) && restoreKeys.length
            ? [primaryKey, ...restoreKeys]
            : [primaryKey]
    ).map(key => filenamify(key));
    const patterns = filenameMatchers.map(matcher => `${matcher}*`);
    const cacheFiles: fg.Entry[] = await fg(patterns, {
        cwd: cacheDir,
        objectMode: true,
        onlyFiles: true,
        stats: true,
        unique: true
    });

    // console.log(JSON.stringify({ patterns, cacheFiles }, null, 2));

    const result = locateCacheFile(filenameMatchers, cacheFiles);

    if (!result) {
        return undefined;
    }

    const { key, cacheFile } = result;

    // Restore files from archive
    const cachePath = join(cacheDir, cacheFile.path);
    const baseDir = dirname(path);
    const cmd = `tar -I pigz -xf ${cachePath} -C ${baseDir}`;

    core.info(
        [
            `Restoring cache: ${cacheFile.name}`,
            `Created: ${cacheFile.stats?.mtime}`,
            `Size: ${prettyBytes(cacheFile.stats?.size || 0)}`
        ].join("\n")
    );
    
    // DEBUG: Show tar command and file system state
    core.info(`🔧 DEBUG - Tar command: ${cmd}`);
    core.info(`📁 DEBUG - Base directory: ${baseDir}`);
    core.info(`📦 DEBUG - Cache file path: ${cachePath}`);
    
    // List files before restore
    core.info(`📋 DEBUG - Files in base directory before restore:`);
    const lsBeforeCmd = `ls -la ${baseDir}`;
    try {
        const { stdout: lsBefore } = await execAsync(lsBeforeCmd);
        core.info(lsBefore);
    } catch (err) {
        core.warning(`Could not list directory ${baseDir}: ${err}`);
    }

    const createCacheDirPromise = execAsync(cmd);

    try {
        await streamOutputUntilResolved(createCacheDirPromise);
        
        // DEBUG: List files after restore
        core.info(`📋 DEBUG - Files in base directory after restore:`);
        const lsAfterCmd = `ls -la ${baseDir}`;
        try {
            const { stdout: lsAfter } = await execAsync(lsAfterCmd);
            core.info(lsAfter);
        } catch (err) {
            core.warning(`Could not list directory ${baseDir} after restore: ${err}`);
        }
    } catch (err) {
        const skipFailure = core.getInput("skip-failure") || false;
        core.warning(`Error running tar: ${err}`);
        if (!skipFailure) {
            throw err;
        }
        const cleanBadFile = execAsync(`rm -rf ${cachePath}`);
        await streamOutputUntilResolved(cleanBadFile);
    }

    return key;
}

/**
 * Saves a list of files with the specified key
 *
 * @param paths a list of file paths to be cached
 * @param key an explicit key for restoring the cache
 * @returns number returns cacheId if the cache was saved successfully and throws an error if save fails
 */
export async function saveCache(paths: string[], key: string): Promise<number> {
    checkPaths(paths);
    checkKey(key);

    // DEBUG: Show all paths received
    core.info(`🔍 DEBUG - All paths received for save:`);
    paths.forEach((p, i) => core.info(`  [${i}]: ${p}`));
    core.info(`⚠️  WARNING - Only processing first path: ${paths[0]}`);
    core.info(`❌ IGNORED - ${paths.length - 1} other path(s): ${paths.slice(1).join(', ')}`);

    // @todo for now we only support a single path.
    const path = paths[0];

    const cacheDir = getCacheDirPath();
    const cacheName = `${filenamify(key)}.tar.gz`;
    const cachePath = join(cacheDir, cacheName);
    const baseDir = dirname(path);
    const folderName = basename(path);

    // Ensure cache dir exists
    await fs.promises.mkdir(cacheDir, { recursive: true });

    const cmd = `tar -I pigz -cf ${cachePath} -C ${baseDir} ${folderName}`;

    core.info(`Save cache: ${cacheName}`);

    // DEBUG: Show tar command and file system state
    core.info(`🔧 DEBUG - Tar command: ${cmd}`);
    core.info(`📁 DEBUG - Base directory: ${baseDir}`);
    core.info(`📂 DEBUG - Folder name to cache: ${folderName}`);
    core.info(`📦 DEBUG - Cache file path: ${cachePath}`);

    // List files before save to show what exists
    core.info(`📋 DEBUG - Files in base directory before save:`);
    const lsBeforeCmd = `ls -la ${baseDir}`;
    try {
        const { stdout: lsBefore } = await execAsync(lsBeforeCmd);
        core.info(lsBefore);
    } catch (err) {
        core.warning(`Could not list directory ${baseDir}: ${err}`);
    }

    // Show what will be included in the tar
    core.info(`📋 DEBUG - Files that will be cached (showing ${folderName} contents):`);
    const lsTargetCmd = `ls -la ${join(baseDir, folderName)}`;
    try {
        const { stdout: lsTarget } = await execAsync(lsTargetCmd);
        core.info(lsTarget);
    } catch (err) {
        core.warning(`Could not list target directory ${join(baseDir, folderName)}: ${err}`);
    }

    const createCacheDirPromise = execAsync(cmd);

    try {
        await streamOutputUntilResolved(createCacheDirPromise);
        
        // DEBUG: Show cache file info after creation
        core.info(`📦 DEBUG - Cache file created successfully`);
        const statCmd = `ls -la ${cachePath}`;
        try {
            const { stdout: statResult } = await execAsync(statCmd);
            core.info(`📦 DEBUG - Cache file details: ${statResult}`);
        } catch (err) {
            core.warning(`Could not stat cache file: ${err}`);
        }

        // Show cache file contents
        core.info(`📦 DEBUG - Cache file contents:`);
        const tarListCmd = `tar -I pigz -tf ${cachePath}`;
        try {
            const { stdout: tarContents } = await execAsync(tarListCmd);
            core.info(tarContents);
        } catch (err) {
            core.warning(`Could not list cache file contents: ${err}`);
        }
    } catch (err) {
        core.warning(`Error running tar: ${err}`);
        const skipFailure = core.getInput("skip-failure") || false;
        const cleanBadFile = execAsync(`rm -rf ${cachePath}`);
        await streamOutputUntilResolved(cleanBadFile);
        if (!skipFailure) {
            throw err;
        }
    }

    return 420;
}
