// @ts-check
/// <reference lib="es2021.weakref" />

/**
 * Cloudflare Worker Environment Variables 
 * 
 * @typedef {Object} Env
 * 
 * @property {string} TAR_FILE_URL - URL to the TAR file
 * E.g. "https://archive.org/download/heinessen-mlp-images/heinessen-mlp-images.tar"
 * @property {string} INDEX_FILE_URL - URL to the binary index file
 * E.g. "https://github.com/firlin123/heinessen-mlp-images-index/releases/download/v1.0.0/output.idx"
 * @property {number} INDEX_FILE_SIZE - Size of the binary index file in bytes
 * E.g. "10172320"
 * @property {string} CACHE_KEY_PREFIX - Prefix for cache keys
 * E.g. "/cf-heinessen-mlp-images/"
 */
/** @typedef {import('@cloudflare/workers-types').ExecutionContext} ExecutionContext */

/**
 * Handles incoming requests to fetch images from the TAR archive.
 * 
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @returns {Promise<Response>}
 */
async function handleRequest(request, env, ctx) {
    const cache = getCache();
    if (cache) {
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
    }
    /** @type {Array<Promise<any>>} */
    const backgroundTasks = [];
    const response = await processRequest(request, env, backgroundTasks);
    if (cache) {
        if (response.status === 404) {
            backgroundTasks.push(cache.put(request, response.clone()));
        } else if (response.ok) {
            if (request.method === 'GET' && response.status !== 206) {
                backgroundTasks.push(cache.put(request, response.clone()));
            } else if (request.method === 'HEAD' || (request.method === 'GET' && response.status === 206)) {
                // Do a separate full background GET for HEAD or partial GET requests for caching
                backgroundTasks.push((async () => {
                    const newRequest = new Request(request.url, {
                        method: 'GET',
                    });
                    const newBackgroundTasks = [];
                    const newResponse = await processRequest(newRequest, env, newBackgroundTasks);
                    if (newResponse.status === 404 || (newResponse.ok && response.status !== 206)) {
                        await cache.put(newRequest, newResponse.clone());
                    }
                    if (newBackgroundTasks.length > 0) {
                        await Promise.all(newBackgroundTasks);
                    }
                })());
            }
        }
    }
    if (backgroundTasks.length > 0) {
        ctx.waitUntil(Promise.all(backgroundTasks));
    }
    return response;
}

/**
 * Retrieves the default cache for the worker.
 * 
 * @returns {Cache | null}
 */
function getCache() {
    /** @type {{ caches: { default: Cache } }} */
    const globalThisAny = /** @type {any} */ (globalThis);
    const cache = globalThisAny.caches?.default;
    if (cache && cache instanceof Cache) {
        return cache;
    }
    return null;
}

/** @type {Record<string, bigint>} */
const EXT_MAP = {
    jpg: 0n,
    jpeg: 0n,
    png: 1n,
    gif: 2n,
    webm: 3n,
};

/**
 * Processes the request to fetch the image from the TAR archive.
 * 
 * @param {Request} request
 * @param {Env} env
 * @param {Array<Promise<any>>} backgroundTasks
 * @returns {Promise<Response>}
 */
async function processRequest(request, env, backgroundTasks) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Allow': 'GET, HEAD, OPTIONS',
                },
            });
        }
        return createErrorResponse(405, 'Method Not Allowed');
    }
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/^\/image\/(\d{4})\/(\d{2})\/(\1\2\d*)\.(\w+)$/);
    if (!pathMatch) {
        return createErrorResponse(404, 'Not Found');
    }
    const timestampStr = pathMatch[3];
    const ext = pathMatch[4].toLowerCase();
    if (!(ext in EXT_MAP)) {
        return createErrorResponse(404, 'Not Found');
    }
    const timestamp = BigInt(timestampStr);
    const extId = EXT_MAP[ext];

    const key = (timestamp << 16n) | (extId << 14n);
    const record = await findRecordInIndex(
        env.INDEX_FILE_URL,
        Number(env.INDEX_FILE_SIZE),
        key, url.origin + env.CACHE_KEY_PREFIX,
        backgroundTasks
    );
    if (!record) {
        return createErrorResponse(404, 'Not Found');
    }

    // Skip the 512-byte TAR header
    const tarOffsetBytes = 512 + (record.offset * 512);
    const fileSize = record.size;

    const rangeHeader = request.headers.get("Range");
    const { start, end, success } = parseRange(rangeHeader, fileSize);
    if (rangeHeader && !success) {
        return createErrorResponse(416, 'Range Not Satisfiable');
    }

    const upstreamStart = tarOffsetBytes + start;
    const upstreamEnd = tarOffsetBytes + end;

    const upstreamHeaders = {
        Range: `bytes=${upstreamStart}-${upstreamEnd}`,
    };

    const upstreamResponse = await fetch(env.TAR_FILE_URL, {
        headers: upstreamHeaders,
        method: request.method
    });
    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
        return createErrorResponse(502, 'Bad Gateway');
    }

    const headers = new Headers({
        "Content-Type": getMimeType(ext),
        "Content-Length": (end - start + 1).toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
    });

    if (rangeHeader) {
        headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    }

    return new Response(upstreamResponse.body, {
        status: rangeHeader ? 206 : 200,
        headers,
    });
}

/** @type {Record<string, string>} */
const MIME_MAP = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webm: 'video/webm',
};

/**
 * Gets the MIME type based on the file extension.
 * 
 * @param {string} ext
 * @returns {string}
 */
function getMimeType(ext) {
    return MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * Parses the Range header.
 * 
 * @param {string | null} rangeHeader
 * @param {number} fileSize
 * @returns {{ start: number, end: number, success: boolean }}
 */
function parseRange(rangeHeader, fileSize) {
    let success = true;
    if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
        success = false;
        return { start: 0, end: fileSize - 1, success };
    }
    const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
        success = false;
        return { start: 0, end: fileSize - 1, success };
    }
    let startStr = match[1];
    let endStr = match[2];
    if (!startStr && !endStr) {
        success = false;
        return { start: 0, end: fileSize - 1, success };
    }
    let start = startStr ? parseInt(startStr, 10) : 0;
    let end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    if (!startStr) {
        // Suffix only (bytes=-N)
        start = fileSize - end;
        end = fileSize - 1;
    }
    if (start < 0) start = 0;
    if (end >= fileSize) end = fileSize - 1;
    if (start > end) {
        start = 0;
        end = fileSize - 1;
        success = false;
    }
    return { start, end, success };
}

const RECORD_SIZE = 16;

/**
 * Finds the record in the binary index file.
 * 
 * @param {string} indexUrl
 * @param {number} indexSize
 * @param {bigint} key
 * @param {string} cacheKeyPrefix
 * @param {Array<Promise<any>>} backgroundTasks
 * @returns {Promise<{ size: number, offset: number } | null>}
 */
async function findRecordInIndex(indexUrl, indexSize, key, cacheKeyPrefix, backgroundTasks) {
    let lo = 0;
    let hi = Math.floor(indexSize / RECORD_SIZE) - 1;

    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;

        const recordBuf = await fetchIndexRecord(mid, cacheKeyPrefix, indexUrl, backgroundTasks);
        const view = new DataView(recordBuf.buffer, recordBuf.byteOffset, recordBuf.byteLength);

        const recordKey = view.getBigUint64(0, true);
        if (recordKey < key) {
            lo = mid + 1;
        } else if (recordKey > key) {
            hi = mid - 1;
        } else {
            const size = view.getUint32(8, true);
            const offset = view.getUint32(12, true);
            return { size, offset };
        }
    }
    return null;
}

const PAGE_SIZE = RECORD_SIZE * 4096;
/** @type {Map<number, WeakRef<Uint8Array>>} */
const MEM_CACHE = new Map();

/**
 * Fetches a specific record from the index file.
 * 
 * @param {number} recordIndex
 * @param {string} cacheKeyPrefix
 * @param {string} indexUrl
 * @param {Array<Promise<any>>} backgroundTasks
 * @returns {Promise<Uint8Array>}
 */
async function fetchIndexRecord(recordIndex, cacheKeyPrefix, indexUrl, backgroundTasks) {
    const byteOffset = recordIndex * RECORD_SIZE;

    const pageStart = Math.floor(byteOffset / PAGE_SIZE) * PAGE_SIZE;
    const offsetInPage = byteOffset - pageStart;

    const memRef = MEM_CACHE.get(pageStart);
    let buffer = memRef?.deref();

    if (memRef && !buffer) {
        MEM_CACHE.delete(pageStart);
    }

    if (!buffer) {
        const cacheKey = new Request(cacheKeyPrefix + pageStart);
        const cache = getCache();
        let cachedRes = cache ? await cache.match(cacheKey) : null;
        if (cachedRes) {
            buffer = new Uint8Array(await cachedRes.arrayBuffer());
        } else {
            const fetchHeaders = {
                Range: `bytes=${pageStart}-${pageStart + PAGE_SIZE - 1}`,
            };
            const fetchRes = await fetch(indexUrl, { headers: fetchHeaders });
            if (!fetchRes.ok || fetchRes.status !== 206) {
                throw new Error(`Failed to fetch index page: ${fetchRes.status} ${fetchRes.statusText}`);
            }

            buffer = new Uint8Array(await fetchRes.arrayBuffer());

            if (cache) {
                backgroundTasks.push(cache.put(cacheKey, new Response(buffer)));
            }
        }

        MEM_CACHE.set(pageStart, new WeakRef(buffer));
    }

    if (offsetInPage + RECORD_SIZE > buffer.length) {
        throw new Error('Index record exceeds page boundary');
    }

    return buffer.subarray(offsetInPage, offsetInPage + RECORD_SIZE);
}

/**
 * Creates an HTML error response.
 * 
 * @param {number} statusCode
 * @param {string} message
 * @returns {Response}
 */
function createErrorResponse(statusCode, message) {
    return new Response(`<html>
<head><title>${statusCode} ${message}</title></head>
<body>
<center><h1>${statusCode} ${message}</h1></center>
<hr><center>nginx</center>
</body>
</html>`, {
        status: statusCode,
        headers: {
            'Content-Type': 'text/html; charset=UTF-8',
            'Connection': 'close',
        },
    });
}

export default {
    /**
     * @param {Request} request
     * @param {Env} env
     * @param {ExecutionContext} ctx
     * @returns {Promise<Response>}
     */
    async fetch(request, env, ctx) {
        return handleRequest(request, env, ctx);
    },
};