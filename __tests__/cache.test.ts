import { exec } from "child_process";
import fs from "fs";
import { resolve } from "path";
import { promisify } from "util";

import * as cache from "../src/cache";

const execAsync = promisify(exec);

const FIXTURES_DIR = resolve(__dirname, "__fixtures__");
const FIXTURES_BACKUP_DIR = resolve(__dirname, "__fixtures-backup__");
const CACHE_DIR = (process.env.CACHE_DIR = resolve(__dirname, "__tmp__"));
const GITHUB_REPOSITORY = (process.env.GITHUB_REPOSITORY = "integration-test");

// Test the getCommonBasePath function
// We need to access the internal function for testing, but it's not exported
// So we'll test it through the behavior of saveCache and restoreCache
describe("getCommonBasePath functionality", () => {
    test("should handle common path scenarios correctly", async () => {
        // Test multiple paths in same directory
        const baseDir = resolve(__dirname, "__common-test__");
        const path1 = resolve(baseDir, "dir1");
        const path2 = resolve(baseDir, "dir2");

        await fs.promises.mkdir(path1, { recursive: true });
        await fs.promises.mkdir(path2, { recursive: true });
        await fs.promises.writeFile(resolve(path1, "test1.txt"), "test1");
        await fs.promises.writeFile(resolve(path2, "test2.txt"), "test2");

        try {
            // Save multiple paths - should find baseDir as common base
            await cache.saveCache([path1, path2], "common-base-test");

            // Remove and restore
            await fs.promises.rm(baseDir, { recursive: true, force: true });
            await cache.restoreCache([path1, path2], "common-base-test");

            // Verify both directories were restored
            expect(
                await fs.promises.readFile(resolve(path1, "test1.txt"), "utf8")
            ).toBe("test1");
            expect(
                await fs.promises.readFile(resolve(path2, "test2.txt"), "utf8")
            ).toBe("test2");
        } finally {
            await fs.promises.rm(baseDir, { recursive: true, force: true });
        }
    });
});

describe("save and restore files", () => {
    beforeEach(async () => {
        await fs.promises.rm(CACHE_DIR, { recursive: true, force: true });
        await fs.promises.rm(FIXTURES_BACKUP_DIR, {
            recursive: true,
            force: true
        });
        await execAsync(`git checkout ${resolve(FIXTURES_DIR)}`);
    });

    test("creates archive file", async () => {
        await cache.saveCache([FIXTURES_DIR], "save-test");
        await fs.promises.access(
            resolve(CACHE_DIR, GITHUB_REPOSITORY, "save-test.tar.gz"),
            fs.constants.R_OK | fs.constants.W_OK
        );
    });

    test("restores single archive file", async () => {
        // Save cache
        await cache.saveCache([FIXTURES_DIR], "restore-test");

        // Create backup dir from fixtrues for comparision
        await fs.promises.rename(FIXTURES_DIR, FIXTURES_BACKUP_DIR);

        // Delete fixtures dir and restore
        await fs.promises.rm(FIXTURES_DIR, {
            recursive: true,
            force: true
        });
        await cache.restoreCache([FIXTURES_DIR], "restore-test");

        // Assert that backup dir and restored dir have the same content
        await execAsync(`diff -Naur ${FIXTURES_DIR} ${FIXTURES_BACKUP_DIR}`);
    });

    test("restore latest archive file", async () => {
        const filePath = resolve(FIXTURES_DIR, "helloWorld.txt");

        // Save cache with fixture file
        await cache.saveCache([FIXTURES_DIR], "latest-archive-test-1");

        // Delete fixture file and save newer cache
        await fs.promises.unlink(filePath);
        await cache.saveCache([FIXTURES_DIR], "latest-archive-test-2");

        // Delete fixtures dir and restore
        await fs.promises.rm(FIXTURES_DIR, {
            recursive: true,
            force: true
        });
        await cache.restoreCache([FIXTURES_DIR], "latest-archive-test");

        // Expect the cache without fixture file to be restored
        return expect(
            fs.promises.access(filePath, fs.constants.R_OK | fs.constants.W_OK)
        ).rejects.toMatchObject({
            code: "ENOENT",
            path: /helloWorld\.txt$/
        });
    });

    test("restore from fallback key", async () => {
        // Save cache
        await cache.saveCache([FIXTURES_DIR], "fallback-test");

        // Create backup dir and remove fixtures
        await fs.promises.rename(FIXTURES_DIR, FIXTURES_BACKUP_DIR);
        // Delete fixtures dir and restore
        await fs.promises.rm(FIXTURES_DIR, {
            recursive: true,
            force: true
        });
        // Restore with non-existing primary key, but a matching fallback key
        await cache.restoreCache([FIXTURES_DIR], "fallback-test-doesnt-exist", [
            "fallback-test"
        ]);

        // Assert that backup dir and restored dir have the same content
        await execAsync(`diff -Naur ${FIXTURES_DIR} ${FIXTURES_BACKUP_DIR}`);
    });

    test("saves and restores multiple paths", async () => {
        // Create additional test directories and files
        const testDir1 = resolve(__dirname, "__test-multiple-1__");
        const testDir2 = resolve(__dirname, "__test-multiple-2__");
        const testFile1 = resolve(testDir1, "file1.txt");
        const testFile2 = resolve(testDir2, "file2.txt");

        // Setup test directories
        await fs.promises.mkdir(testDir1, { recursive: true });
        await fs.promises.mkdir(testDir2, { recursive: true });
        await fs.promises.writeFile(testFile1, "content of file 1");
        await fs.promises.writeFile(testFile2, "content of file 2");

        try {
            // Save cache with multiple paths
            await cache.saveCache([testDir1, testDir2], "multiple-paths-test");

            // Verify cache file was created
            await fs.promises.access(
                resolve(
                    CACHE_DIR,
                    GITHUB_REPOSITORY,
                    "multiple-paths-test.tar.gz"
                ),
                fs.constants.R_OK | fs.constants.W_OK
            );

            // Remove original directories
            await fs.promises.rm(testDir1, { recursive: true, force: true });
            await fs.promises.rm(testDir2, { recursive: true, force: true });

            // Restore from cache
            await cache.restoreCache(
                [testDir1, testDir2],
                "multiple-paths-test"
            );

            // Verify both directories and their content were restored
            const content1 = await fs.promises.readFile(testFile1, "utf8");
            const content2 = await fs.promises.readFile(testFile2, "utf8");

            expect(content1).toBe("content of file 1");
            expect(content2).toBe("content of file 2");
        } finally {
            // Cleanup
            await fs.promises.rm(testDir1, { recursive: true, force: true });
            await fs.promises.rm(testDir2, { recursive: true, force: true });
        }
    });

    test("saves and restores multiple paths with nested structure", async () => {
        // Create nested test structure
        const baseDir = resolve(__dirname, "__test-nested__");
        const subDir1 = resolve(baseDir, "subdir1");
        const subDir2 = resolve(baseDir, "subdir2");
        const nestedDir = resolve(subDir1, "nested");

        const file1 = resolve(subDir1, "file1.txt");
        const file2 = resolve(subDir2, "file2.txt");
        const nestedFile = resolve(nestedDir, "nested.txt");

        // Setup test structure
        await fs.promises.mkdir(nestedDir, { recursive: true });
        await fs.promises.mkdir(subDir2, { recursive: true });
        await fs.promises.writeFile(file1, "file in subdir1");
        await fs.promises.writeFile(file2, "file in subdir2");
        await fs.promises.writeFile(nestedFile, "nested file content");

        try {
            // Save cache with multiple nested paths
            await cache.saveCache([subDir1, subDir2], "nested-paths-test");

            // Remove original structure
            await fs.promises.rm(baseDir, { recursive: true, force: true });

            // Restore from cache
            await cache.restoreCache([subDir1, subDir2], "nested-paths-test");

            // Verify all content was restored correctly
            const content1 = await fs.promises.readFile(file1, "utf8");
            const content2 = await fs.promises.readFile(file2, "utf8");
            const nestedContent = await fs.promises.readFile(
                nestedFile,
                "utf8"
            );

            expect(content1).toBe("file in subdir1");
            expect(content2).toBe("file in subdir2");
            expect(nestedContent).toBe("nested file content");
        } finally {
            // Cleanup
            await fs.promises.rm(baseDir, { recursive: true, force: true });
        }
    });

    test("handles edge case: multiple paths with different root directories", async () => {
        // Create test structure with very different paths
        const testDir1 = resolve(__dirname, "__edge-test-1__");
        const testDir2 = resolve(__dirname, "__edge-test-2__");
        const file1 = resolve(testDir1, "file1.txt");
        const file2 = resolve(testDir2, "file2.txt");

        await fs.promises.mkdir(testDir1, { recursive: true });
        await fs.promises.mkdir(testDir2, { recursive: true });
        await fs.promises.writeFile(file1, "edge case content 1");
        await fs.promises.writeFile(file2, "edge case content 2");

        try {
            // Save and restore
            await cache.saveCache([testDir1, testDir2], "edge-case-test");

            await fs.promises.rm(testDir1, { recursive: true, force: true });
            await fs.promises.rm(testDir2, { recursive: true, force: true });

            await cache.restoreCache([testDir1, testDir2], "edge-case-test");

            // Verify restoration
            const content1 = await fs.promises.readFile(file1, "utf8");
            const content2 = await fs.promises.readFile(file2, "utf8");

            expect(content1).toBe("edge case content 1");
            expect(content2).toBe("edge case content 2");
        } finally {
            await fs.promises.rm(testDir1, { recursive: true, force: true });
            await fs.promises.rm(testDir2, { recursive: true, force: true });
        }
    });

    test("maintains backward compatibility with single path arrays", async () => {
        // This should work exactly like before - using existing fixtures
        const originalKey = "backward-compat-test";

        // Save with single-item array (existing behavior)
        await cache.saveCache([FIXTURES_DIR], originalKey);

        // Create backup and remove original
        await fs.promises.rename(FIXTURES_DIR, FIXTURES_BACKUP_DIR);
        await fs.promises.rm(FIXTURES_DIR, { recursive: true, force: true });

        // Restore with single-item array
        await cache.restoreCache([FIXTURES_DIR], originalKey);

        // Should be identical to backup
        await execAsync(`diff -Naur ${FIXTURES_DIR} ${FIXTURES_BACKUP_DIR}`);
    });
});
