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
    
    core.info(`Restoring cache for ${paths.length} path pattern(s): ${paths.join(', ')}`);
    
    // We don't need to expand paths for restore since the cache was built with expanded paths
    // The tar file contains all the necessary directories/files
    // We'll extract to the project root (current working directory)

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
    const baseDir = process.cwd(); // Extract to project root
    const cmd = `tar -I zstdmt -xf "${cachePath}" -C "${baseDir}"`;

    core.info(
        [
            `Restoring cache: ${cacheFile.name}`,
            `Created: ${cacheFile.stats?.mtime}`,
            `Size: ${prettyBytes(cacheFile.stats?.size || 0)}`
        ].join("\n")
    );
    
    core.info(`Extracting cache to project root...`);

    const createCacheDirPromise = execAsync(cmd);

    try {
        await streamOutputUntilResolved(createCacheDirPromise);
        
        core.info(`Cache restored successfully`);
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

    // Expand all paths using fast-glob to handle patterns like packages/*/node_modules
    core.info(`Expanding ${paths.length} path pattern(s)...`);
    const expandedPaths: string[] = [];
    
    for (const pathPattern of paths) {
        try {
            // Use fast-glob to expand patterns and check if paths exist
            const matches = await fg(pathPattern, {
                onlyDirectories: false, // Include both files and directories
                suppressErrors: true,   // Don't throw on permission errors
                followSymbolicLinks: false
            });
            
            if (matches.length > 0) {
                expandedPaths.push(...matches);
                core.info(`${pathPattern} -> ${matches.length} match(es)`);
            } else {
                // If no glob matches, check if it's a literal path that exists
                try {
                    const stat = await fs.promises.stat(pathPattern);
                    expandedPaths.push(pathPattern);
                    core.info(`${pathPattern} -> found (${stat.isDirectory() ? 'directory' : 'file'})`);
                } catch {
                    core.info(`${pathPattern} -> not found (skipping)`);
                }
            }
        } catch (err) {
            core.warning(`Error expanding path ${pathPattern}: ${err}`);
        }
    }

    if (expandedPaths.length === 0) {
        throw new Error("No valid paths found to cache after expansion");
    }

    core.info(`Caching ${expandedPaths.length} path(s): ${expandedPaths.join(', ')}`);

    const cacheDir = getCacheDirPath();
    const cacheName = `${filenamify(key)}.tar.zst`;
    const cachePath = join(cacheDir, cacheName);
    
    // Use current working directory as base for all relative paths
    const baseDir = process.cwd();

    // Ensure cache dir exists
    await fs.promises.mkdir(cacheDir, { recursive: true });

    // Build tar command with all expanded paths
    const pathsForTar = expandedPaths.map(p => `"${p}"`).join(' ');
    const cmd = `tar -I zstdmt -cf "${cachePath}" -C "${baseDir}" ${pathsForTar}`;

    core.info(`Creating cache archive: ${cacheName}`);

    const createCacheDirPromise = execAsync(cmd);

    try {
        await streamOutputUntilResolved(createCacheDirPromise);
                
        // Show final cache file size
        try {
            const stat = await fs.promises.stat(cachePath);
            core.info(`Cache saved successfully (${prettyBytes(stat.size)})`);
        } catch (err) {
            core.info(`Cache saved successfully`);
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
