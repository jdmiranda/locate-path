import process from 'node:process';
import path from 'node:path';
import fs, {promises as fsPromises} from 'node:fs';
import {fileURLToPath} from 'node:url';
import pLocate from 'p-locate';

const typeMappings = {
	directory: 'isDirectory',
	file: 'isFile',
};

function checkType(type) {
	if (type === 'both' || Object.hasOwn(typeMappings, type)) {
		return;
	}

	throw new Error(`Invalid type specified: ${type}`);
}

const matchType = (type, stat) => type === 'both' ? (stat.isFile() || stat.isDirectory()) : stat[typeMappings[type]]();

const toPath = urlOrPath => urlOrPath instanceof URL ? fileURLToPath(urlOrPath) : urlOrPath;

// LRU Cache implementation for path existence checks
class LRUCache {
	constructor(maxSize = 500, ttl = 5000) {
		this.maxSize = maxSize;
		this.ttl = ttl;
		this.cache = new Map();
	}

	get(key) {
		const entry = this.cache.get(key);
		if (!entry) {
			return undefined;
		}

		// Check TTL expiration
		if (Date.now() - entry.timestamp > this.ttl) {
			this.cache.delete(key);
			return undefined;
		}

		// Move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.value;
	}

	set(key, value) {
		// Remove if exists (to update position)
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxSize) {
			// Remove oldest entry (first item)
			const firstKey = this.cache.keys().next().value;
			this.cache.delete(firstKey);
		}

		this.cache.set(key, {
			value,
			timestamp: Date.now(),
		});
	}

	clear() {
		this.cache.clear();
	}
}

// Global caches with TTL
const statCache = new LRUCache(500, 5000); // 5 second TTL
const negativeCache = new LRUCache(500, 5000); // Cache for non-existent paths

// Helper function to check and cache path
function checkPathSync(resolvedPath, {cacheKey, type, statFunction, useCache}) {
	try {
		const stat = statFunction(resolvedPath, {
			throwIfNoEntry: false,
		});

		if (!stat) {
			// Cache negative result
			if (useCache) {
				negativeCache.set(cacheKey, false);
			}

			return false;
		}

		const typeMatches = matchType(type, stat);

		if (typeMatches) {
			// Cache positive result
			if (useCache) {
				statCache.set(cacheKey, true);
			}

			return true;
		}

		// Cache negative result for type mismatch
		if (useCache) {
			negativeCache.set(cacheKey, false);
		}

		return false;
	} catch {
		// Cache negative result on error
		if (useCache) {
			negativeCache.set(cacheKey, false);
		}

		return false;
	}
}

export async function locatePath(
	paths,
	{
		cwd = process.cwd(),
		type = 'file',
		allowSymlinks = true,
		concurrency,
		preserveOrder,
		useCache = true,
	} = {},
) {
	checkType(type);
	cwd = toPath(cwd);

	const statFunction = allowSymlinks ? fsPromises.stat : fsPromises.lstat;

	return pLocate(paths, async path_ => {
		// Fast path: check if path is already absolute
		const resolvedPath = path.isAbsolute(path_) ? path_ : path.resolve(cwd, path_);

		// Create cache key including type and allowSymlinks for accuracy
		const cacheKey = `${resolvedPath}:${type}:${allowSymlinks}`;

		// Check negative cache first (fastest check)
		if (useCache && negativeCache.get(cacheKey) === false) {
			return false;
		}

		// Check positive cache
		if (useCache) {
			const cached = statCache.get(cacheKey);
			if (cached !== undefined) {
				return cached;
			}
		}

		try {
			const stat = await statFunction(resolvedPath);
			const result = matchType(type, stat);

			// Cache the result
			if (useCache) {
				if (result) {
					statCache.set(cacheKey, result);
				} else {
					negativeCache.set(cacheKey, false);
				}
			}

			return result;
		} catch {
			// Cache negative result
			if (useCache) {
				negativeCache.set(cacheKey, false);
			}

			return false;
		}
	}, {concurrency, preserveOrder});
}

export function locatePathSync(
	paths,
	{
		cwd = process.cwd(),
		type = 'file',
		allowSymlinks = true,
		useCache = true,
	} = {},
) {
	checkType(type);
	cwd = toPath(cwd);

	const statFunction = allowSymlinks ? fs.statSync : fs.lstatSync;

	for (const path_ of paths) {
		// Fast path: check if path is already absolute
		const resolvedPath = path.isAbsolute(path_) ? path_ : path.resolve(cwd, path_);

		// Create cache key including type and allowSymlinks for accuracy
		const cacheKey = `${resolvedPath}:${type}:${allowSymlinks}`;

		// Check negative cache first (fastest check)
		if (useCache && negativeCache.get(cacheKey) === false) {
			continue;
		}

		// Check positive cache
		if (useCache) {
			const cached = statCache.get(cacheKey);
			if (cached !== undefined) {
				if (cached) {
					return path_;
				}

				continue;
			}
		}

		// Check path and cache result
		if (checkPathSync(resolvedPath, {
			cacheKey,
			type,
			statFunction,
			useCache,
		})) {
			return path_;
		}
	}
}
