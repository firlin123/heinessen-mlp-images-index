#!/usr/bin/env node
// @ts-check

// to obtain tar_list.txt run the following command: (it will take no less then 5 hours, depending on your connection speed)
// curl -L https://archive.org/download/heinessen-mlp-images/heinessen-mlp-images.tar | tar -tv --block-number > tar_list.txt

import { createReadStream } from 'fs';
import { writeFile } from 'fs/promises';
import { createInterface } from 'readline';

// Extension to ID mapping
/** @type {Record<string, bigint>} */
const EXT_MAP = {
    jpg: 0n,
    jpeg: 0n,
    png: 1n,
    gif: 2n,
    webm: 3n,
};

// Binary Format (Little Endian):
// [0-7]  : 64-bit Key (Timestamp << 16 | ExtID << 14)
// [8-11] : 32-bit Size (File size in bytes)
// [12-15]: 32-bit Offset (TAR Block number)
const RECORD_SIZE = 16;

const RE_EOF = /^block (\d+):\s\*\* Block of NULs \*\*$/;
const RE_FILE = /^block (\d+):\s([^\s]+)\s+[^\s]+\s+(\d+)\s+[^\s]+\s+[^\s]+\s+(.*)$/;

const RE_PATH = /^image\/(\d{4})\/(\d{2})\/(\1\2\d*)\.(\w+)$/;

/**
 * Builds the index from the TAR list file.
 * 
 * @param {string} tarListPath - Path to the TAR list text file.
 * @param {string} outputPath - Path to output the binary index file.
 * @param {boolean} lax - Whether to operate in lax mode (skip errors).
 */
async function buildIndex(tarListPath, outputPath, lax) {
    const strict = !lax;
    const inStream = createReadStream(tarListPath);
    /** @type {Buffer[]} */
    const records = [];

    const rl = createInterface({
        input: inStream,
        crlfDelay: Infinity
    });

    /** @type {{ blockNum: number, path: string, size: number } | null} */
    let prev = null;

    console.log('Processing TAR list...');

    for await (const line of rl) {
        const match = line.match(line.endsWith('** Block of NULs **') ? RE_EOF : RE_FILE);
        if (!match) {
            if (strict) {
                console.error(`Unrecognized line format: ${line}`);
                process.exit(1);
            }
            console.warn(`Skipping unrecognized line: ${line}`);
            continue;
        }

        const blockNum = Number(match[1]);
        const permissions = match[2] || '';
        const size = Number(match[3] || '0');
        const path = match[4] || 'EOF';
        const isDir = permissions.startsWith('d');

        if (prev) {
            const blocksUsed = 1 + Math.ceil(prev.size / 512);
            const blocksActual = blockNum - prev.blockNum;
            if (blocksUsed !== blocksActual) {
                if (strict) {
                    console.error(`Size mismatch: ${prev.path} expected ${blocksUsed * 512} bytes but got ${blocksActual * 512} bytes`);
                    process.exit(1);
                }
                console.warn(`Size mismatch: ${prev.path} expected ${blocksUsed * 512} bytes but got ${blocksActual * 512} bytes`);
            }
        }

        prev = { blockNum, path, size };
        if (path === 'EOF') break;
        if (isDir) continue;

        const pathMatch = path.match(RE_PATH);
        if (!pathMatch) {
            if (strict) {
                console.error(`Path does not match expected format: ${path}`);
                process.exit(1);
            }
            console.warn(`Skipping unexpected path format: ${path}`);
            continue;
        }

        const timestampStr = pathMatch[3];
        const ext = pathMatch[4].toLowerCase();

        if (!(ext in EXT_MAP)) {
            if (strict) {
                console.error(`Unknown file extension: ${ext} in path ${path}`);
                process.exit(1);
            }
            console.warn(`Skipping unknown file extension: ${ext} in path ${path}`);
            continue;
        }

        const timestamp = BigInt(timestampStr);
        const extId = EXT_MAP[ext];

        const key = (timestamp << 16n) | (extId << 14n);

        const record = Buffer.alloc(RECORD_SIZE);
        record.writeBigUInt64LE(key, 0);
        record.writeUInt32LE(size, 8);
        record.writeUInt32LE(blockNum, 12);

        records.push(record);
    }

    console.log(`Sorting ${records.length} records...`);

    records.sort((a, b) => {
        // First by Key
        const keyA = a.readBigUInt64LE(0);
        const keyB = b.readBigUInt64LE(0);
        if (keyA !== keyB) return keyA < keyB ? -1 : 1;

        // Then by Size
        const sizeA = a.readUInt32LE(8);
        const sizeB = b.readUInt32LE(8);
        if (sizeA !== sizeB) return sizeA - sizeB;

        // Finally by Offset
        return a.readUInt32LE(12) - b.readUInt32LE(12);
    });

    console.log(`Writing index to ${outputPath}...`);
    await writeFile(outputPath, Buffer.concat(records));

    console.log('Index build complete.');
}

/**
 * Parses command line arguments.
 * 
 * @param {string[]} argv - Command line arguments.
 * @returns {{ tarListPath: string, outputPath: string, lax: boolean }}
 */
function parseArgs(argv) {
    let tarListPath = '';
    let outputPath = '';
    let lax = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--lax' || arg === '-l') {
            lax = true;
        }
        else if (!tarListPath) {
            tarListPath = arg;
        } else if (!outputPath) {
            outputPath = arg;
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(1);
        }
    }
    if (!tarListPath || !outputPath) {
        console.error('Usage: node builder.js [--lax/-l] <tar_list.txt> <static_assets/heinessen-mlp-images-index.bin>');
        process.exit(1);
    }
    return { tarListPath, outputPath, lax };
}

const args = parseArgs(process.argv.slice(2));

buildIndex(args.tarListPath, args.outputPath, args.lax).catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});