// @ts-check
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Worker Environment Variables 
 * 
 * @typedef {Object} Env
 * 
 * @property {string} TAR_FILE_URL - URL to the TAR file
 * E.g. "https://archive.org/download/heinessen-mlp-images/heinessen-mlp-images.tar"
 * @property {Fetcher} INDEX - Index asset binding
 * @property {string} INDEX_PATH - Path to the binary index file
 * E.g. "/heinessen-mlp-images-index.bin"
 * @property {number} INDEX_FILE_SIZE - Size of the binary index file in bytes
 * E.g. "10172320"
 */

const cache = getCache();

/**
 * Handles incoming requests to fetch images from the TAR archive.
 * 
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @returns {Promise<Response>}
 */
async function handleRequest(request, env, ctx) {
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
                    const newHeaders = new Headers(request.headers);
                    if (newHeaders.has('Range')) {
                        newHeaders.delete('Range');
                    }
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
    if (url.pathname === '/image/all') {
        let startIdx = 0;
        let endIdx = 0;
        if (url.searchParams.has('start')) {
            const startParam = url.searchParams.get('start');
            if (startParam && startParam.match(/^\d+$/)) {
                startIdx = parseInt(startParam, 10);
            }
        }
        if (url.searchParams.has('end')) {
            const endParam = url.searchParams.get('end');
            if (endParam && endParam.match(/^\d+$/)) {
                endIdx = parseInt(endParam, 10);
            }
        }
        if (startIdx !== 0 && endIdx !== 0) {
            if (startIdx > endIdx) {
                const tmp = startIdx;
                startIdx = endIdx;
                endIdx = tmp;
            }
        } else if (startIdx === 0 && endIdx === 0) {
            startIdx = 1400000000000;
            endIdx = startIdx + 10000000;
        } else if (startIdx === 0) {
            startIdx = endIdx - 10000000;
        } else if (endIdx === 0) {
            endIdx = startIdx + 10000000;
        }
        const title = `Index of /images/all?start=${startIdx}&end=${endIdx}`;
        return dirListingResponse(BigInt(startIdx), BigInt(endIdx), title, env, url.origin, backgroundTasks);
    }
    const dirMatch = url.pathname.match(/^\/image\/(\d{4})\/(\d{2})\/?$/);
    if (dirMatch) {
        const d1_4 = dirMatch[1];
        const d5_6 = dirMatch[2];
        const startIdx = BigInt(d1_4 + d5_6 + '0000000');
        const endIdx = BigInt(d1_4 + d5_6 + '9999999');
        const title = `Index of /image/${d1_4}/${d5_6}/`;
        return dirListingResponse(startIdx, endIdx, title, env, url.origin, backgroundTasks);
    }
    const pathMatch = url.pathname.match(/^\/image\/(\d{4})\/(\d{2})\/(\1\2\d*)\.(\w+)$/);
    if (!pathMatch) {
        return env.INDEX.fetch(request);
    }
    const timestampStr = pathMatch[3];
    const ext = pathMatch[4].toLowerCase();
    if (!(ext in EXT_MAP)) {
        return env.INDEX.fetch(request);
    }
    const timestamp = BigInt(timestampStr);
    const extId = EXT_MAP[ext];

    const key = (timestamp << 16n) | (extId << 14n);
    const record = await findRecordInIndex(
        env, url.origin,
        Number(env.INDEX_FILE_SIZE),
        key,
        backgroundTasks
    );
    if (!record) {
        return env.INDEX.fetch(request);
    }

    // Skip the 512-byte TAR header
    const tarOffsetBytes = 512 + (record.offset * 512);
    const fileSize = record.size;

    const rangeHeader = request.headers.get("Range");
    const { start, end, success } = parseRange(rangeHeader, fileSize);
    if (rangeHeader && !success) {
        return env.INDEX.fetch(request);
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

/**
 * Creates a directory listing response.
 * 
 * @param {bigint} startTimestamp
 * @param {bigint} endTimestamp
 * @param {string} title
 * @param {Env} env
 * @param {string} origin
 * @param {Array<Promise<any>>} backgroundTasks
 * @returns {Promise<Response>}
 */
async function dirListingResponse(startTimestamp, endTimestamp, title, env, origin, backgroundTasks) {
    let startKey = (startTimestamp << 16n);
    let endKey = (endTimestamp << 16n) | (3n << 14n);
    if (startKey > endKey) {
        const tmp = startKey;
        startKey = endKey;
        endKey = tmp;
    }

    const minResult = fetchIndexRecord(0, env, origin, backgroundTasks);
    const minRecordBuf = minResult instanceof Promise ? await minResult : minResult;
    const minView = new DataView(minRecordBuf.buffer, minRecordBuf.byteOffset, minRecordBuf.byteLength);
    const minKey = minView.getBigUint64(0, true);
    if (endKey < minKey) {
        return renderDirListing(1, 0, title, env, origin, backgroundTasks);
    }
    if (startKey < minKey) {
        startKey = minKey;
    }

    const indexSize = Number(env.INDEX_FILE_SIZE);
    const recordCount = Math.floor(indexSize / RECORD_SIZE);

    const maxResult = fetchIndexRecord(recordCount - 1, env, origin, backgroundTasks);
    const maxRecordBuf = maxResult instanceof Promise ? await maxResult : maxResult;
    const maxView = new DataView(maxRecordBuf.buffer, maxRecordBuf.byteOffset, maxRecordBuf.byteLength);
    const maxKey = maxView.getBigUint64(0, true);
    if (startKey > maxKey) {
        return renderDirListing(1, 0, title, env, origin, backgroundTasks);
    }
    if (endKey > maxKey) {
        endKey = maxKey;
    }

    const lowerIdx = await findClosest(startKey, 0, true);
    if (lowerIdx === -1) {
        return renderDirListing(1, 0, title, env, origin, backgroundTasks);
    }
    const upperIdx = await findClosest(endKey, lowerIdx, false);
    if (upperIdx === -1) {
        return renderDirListing(1, 0, title, env, origin, backgroundTasks);
    }
    return renderDirListing(lowerIdx, upperIdx, title, env, origin, backgroundTasks);

    /**
     * Finds the closest index for the given key.
     * 
     * @param {bigint} key
     * @param {number} lo
     * @param {boolean} findLower
     * @returns {Promise<number>}
     */
    async function findClosest(key, lo, findLower) {
        let hi = recordCount - 1;
        let resultIdx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const result = fetchIndexRecord(mid, env, origin, backgroundTasks);
            const recordBuf = result instanceof Promise ? await result : result;
            const view = new DataView(recordBuf.buffer, recordBuf.byteOffset, recordBuf.byteLength);
            const recordKey = view.getBigUint64(0, true);
            if (recordKey < key) {
                lo = mid + 1;
                if (!findLower) {
                    resultIdx = mid;
                }
            } else if (recordKey > key) {
                hi = mid - 1;
                if (findLower) {
                    resultIdx = mid;
                }
            } else {
                return mid;
            }
        }
        return resultIdx;
    }
}

/**
 * Renders the directory listing HTML response.
 * 
 * @param {number} lowerIdx
 * @param {number} upperIdx
 * @param {string} title
 * @param {Env} env
 * @param {string} origin
 * @param {Array<Promise<any>>} backgroundTasks
 * @returns {Response}
 */
function renderDirListing(lowerIdx, upperIdx, title, env, origin, backgroundTasks) {
    console.log(`Rendering directory listing for ${title}: records ${lowerIdx} to ${upperIdx}`);
    const { readable, writable } = new TransformStream();

    backgroundTasks.push((async () => {
        const encoder = new TextEncoder();
        const writer = writable.getWriter();
        await writer.write(encoder.encode(`<html>
<head><title>${title}</title></head>
<body>
<h1>${title}</h1>
<style>
table { border-collapse: collapse; width: 50%; }
th, td { border: 1px solid #ddd; padding: 8px; }
th { cursor: pointer; background-color: #f2f2f2; }
th.asc::after { content: " ▲"; }
th.desc::after { content: " ▼"; }
</style>
<hr>
<table>
<thead><tr><th id="sort-name" class="asc">Name</th><th id="sort-size">Size</th></tr></thead>
<tbody>
`));
        let continuousSync = 0;
        for (let i = lowerIdx; i <= upperIdx; i++) {
            const result = fetchIndexRecord(i, env, origin, backgroundTasks);
            const recordBuf = result instanceof Promise ? await result : result;
            continuousSync = (result instanceof Promise) ? 0 : continuousSync + 1;
            const view = new DataView(recordBuf.buffer, recordBuf.byteOffset, recordBuf.byteLength);
            const recordKey = view.getBigUint64(0, true);
            const size = view.getUint32(8, true);
            const timestamp = recordKey >> 16n;
            const extId = (recordKey >> 14n) & 0x3n;
            const ext = extId === 0n ? 'jpg' : extId === 1n ? 'png' : extId === 2n ? 'gif' : 'webm';
            const fileName = `${timestamp}.${ext}`;
            const d1_4_str = fileName.slice(0, 4);
            const d5_6_str = fileName.slice(4, 6);
            const fileUrl = `/image/${d1_4_str}/${d5_6_str}/${fileName}`;
            await writer.write(encoder.encode(`<tr><td><a href="${fileUrl}">${fileName}</a></td><td>${size}</td></tr>\n`));
            if (continuousSync >= 300) {
                await new Promise(resolve => setTimeout(resolve, 0));
                continuousSync = 0;
            }
        }
        await writer.write(encoder.encode(`</tbody>
</table>
<hr>
<script>
const tbody = document.querySelector('tbody');
var navigationTR = null;
var pathParts = location.pathname.split('/');
console.log('pathParts:', pathParts);
if(pathParts.length > 4) {
    var d1_4 = parseInt(pathParts[2], 10);
    var d5_6 = parseInt(pathParts[3], 10);
    if(!isNaN(d1_4) && !isNaN(d5_6)) {
        var next_d1_6 = d1_4 * 100 + d5_6 + 1;
        var prev_d1_6 = d1_4 * 100 + d5_6 - 1;
        var next_d1_6_str = next_d1_6.toString().padStart(6, '0');
        var prev_d1_6_str = prev_d1_6.toString().padStart(6, '0');
        var next_d1_4_str = next_d1_6_str.slice(0, 4);
        var next_d5_6_str = next_d1_6_str.slice(4, 6);
        var prev_d1_4_str = prev_d1_6_str.slice(0, 4);
        var prev_d5_6_str = prev_d1_6_str.slice(4, 6);
        navigationTR = document.createElement('tr');
        navigationTR.className = 'navigationTR';
        navigationTR.innerHTML = '<td colspan="2" style="text-align: center;" cass="navigationTR">' +
            '<a href="/">Root</a><br>' +
            (prev_d1_6 >= 0 ? '<a href="/image/' + prev_d1_4_str + '/' + prev_d5_6_str + '/"> &lt;&lt; Previous</a> ' : '') +
            '<a href="/image/' + d1_4.toString().padStart(4, '0') + '/' + d5_6.toString().padStart(2, '0') + '/">...</a> ' +
            '<a href="/image/' + next_d1_4_str + '/' + next_d5_6_str + '/">Next &gt;&gt;</a>' +
            '</td>';
        tbody.insertBefore(navigationTR, tbody.firstChild);
    }
}
var sortedByName = true;
var ascending = true;
var rows = Array.from(document.querySelectorAll('tbody tr:not(.navigationTR)'));
var sortNameHeader = document.getElementById('sort-name');
var sortSizeHeader = document.getElementById('sort-size');
sortNameHeader.onclick = function() {
    if(sortedByName) {
        ascending = !ascending;
    } else {
        sortSizeHeader.className = '';
        sortedByName = true;
        ascending = false;
    }
    sortNameHeader.className = ascending ? 'asc' : 'desc';
    if(ascending) {
        rows.sort(function (a, b) { return a.children[0].textContent.localeCompare(b.children[0].textContent); });
    } else {
        rows.sort(function (b, a) { return a.children[0].textContent.localeCompare(b.children[0].textContent); });
    }
    tbody.innerHTML = '';
    if(navigationTR) {
        tbody.appendChild(navigationTR);
    }
    rows.forEach(row => tbody.appendChild(row));
};
sortSizeHeader.onclick = function() {
    if(!sortedByName) {
        ascending = !ascending;
    } else {
        sortNameHeader.className = '';
        sortedByName = false;
        ascending = false;
    }
    sortSizeHeader.className = ascending ? 'asc' : 'desc';
    if(ascending) {
        rows.sort(function (a, b) { return parseInt(a.children[1].textContent) - parseInt(b.children[1].textContent); });
    } else {
        rows.sort(function (b, a) { return parseInt(a.children[1].textContent) - parseInt(b.children[1].textContent); });
    }
    tbody.innerHTML = '';
    if(navigationTR) {
        tbody.appendChild(navigationTR);
    }
    rows.forEach(row => tbody.appendChild(row));
}
</script>
</body>
</html>`));
        await writer.close();
    })());

    return new Response(readable, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=UTF-8',
        },
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

// Binary Format (Little Endian):
// [0-7]  : 64-bit Key (Timestamp << 16 | ExtID << 14)
// [8-11] : 32-bit Size (File size in bytes)
// [12-15]: 32-bit Offset (TAR Block number)
const RECORD_SIZE = 16;

/**
 * Finds the record in the binary index file.
 * 
 * @param {Env} env
 * @param {string} origin
 * @param {number} indexSize
 * @param {bigint} key
 * @param {Array<Promise<any>>} backgroundTasks
 * @returns {Promise<{ size: number, offset: number } | null>}
 */
async function findRecordInIndex(env, origin, indexSize, key, backgroundTasks) {
    let lo = 0;
    let hi = Math.floor(indexSize / RECORD_SIZE) - 1;

    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;

        const result = fetchIndexRecord(mid, env, origin, backgroundTasks);
        const recordBuf = result instanceof Promise ? await result : result;
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

/** @type {{ buffer: Uint8Array | null }} */
const MEM_CACHE = { buffer: null };

/**
 * Fetches a specific record from the index file.
 * 
 * @param {number} recordIndex
 * @param {Env} env
 * @param {string} origin
 * @param {Array<Promise<any>>} backgroundTasks
 * @returns {Promise<Uint8Array> | Uint8Array}
 */
function fetchIndexRecord(recordIndex, env, origin, backgroundTasks) {
    const byteOffset = recordIndex * RECORD_SIZE;

    const buffer = MEM_CACHE.buffer;
    if (buffer && byteOffset + RECORD_SIZE <= buffer.length) {
        return buffer.subarray(byteOffset, byteOffset + RECORD_SIZE);
    }
    return fetchIndexRecordAsync(recordIndex, env, origin, backgroundTasks);
}

/**
 * Fetches a specific record from the index file asynchronously.
 * 
 * @param {number} recordIndex
 * @param {Env} env
 * @param {string} origin
 * @param {Array<Promise<any>>} backgroundTasks
 * @returns {Promise<Uint8Array>}
 */
async function fetchIndexRecordAsync(recordIndex, env, origin, backgroundTasks) {
    const byteOffset = recordIndex * RECORD_SIZE;
    /** @type {Uint8Array | null} */
    let buffer = null;
    const fetchKey = new Request(origin + env.INDEX_PATH);
    let fetchRes = cache ? await cache.match(fetchKey) : null;
    if (fetchRes) {
        buffer = new Uint8Array(await fetchRes.arrayBuffer());
    } else {
        fetchRes = await env.INDEX.fetch(fetchKey);
        if (!fetchRes.ok) {
            throw new Error(`Failed to fetch index file: ${fetchRes.status} ${fetchRes.statusText}`);
        }
        buffer = new Uint8Array(await fetchRes.arrayBuffer());
        if (cache) {
            backgroundTasks.push(cache.put(fetchKey, new Response(buffer.slice(0), {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': buffer.length.toString(),
                },
            })));
        }
    }
    MEM_CACHE.buffer = buffer;
    if (byteOffset + RECORD_SIZE > buffer.length) {
        throw new Error('Index record exceeds file size');
    }
    return buffer.subarray(byteOffset, byteOffset + RECORD_SIZE);
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