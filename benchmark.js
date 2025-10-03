import {performance} from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {locatePath, locatePathSync} from './index.js';

// Benchmark utilities
function formatNumber(num) {
	return num.toLocaleString('en-US', {maximumFractionDigits: 2});
}

function formatOpsPerSec(opsPerSec) {
	if (opsPerSec >= 1_000_000) {
		return `${formatNumber(opsPerSec / 1_000_000)}M ops/sec`;
	}
	if (opsPerSec >= 1_000) {
		return `${formatNumber(opsPerSec / 1_000)}K ops/sec`;
	}
	return `${formatNumber(opsPerSec)} ops/sec`;
}

async function benchmark(name, fn, iterations = 1000) {
	// Warmup
	for (let i = 0; i < 10; i++) {
		await fn();
	}

	// Actual benchmark
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		await fn();
	}
	const end = performance.now();

	const totalTime = end - start;
	const avgTime = totalTime / iterations;
	const opsPerSec = (iterations / totalTime) * 1000;

	console.log(`\n${name}:`);
	console.log(`  Total time: ${formatNumber(totalTime)}ms`);
	console.log(`  Average time: ${formatNumber(avgTime)}ms`);
	console.log(`  Throughput: ${formatOpsPerSec(opsPerSec)}`);

	return {name, totalTime, avgTime, opsPerSec};
}

// Create test fixtures
const testDir = '/tmp/locate-path-bench';
if (fs.existsSync(testDir)) {
	fs.rmSync(testDir, {recursive: true});
}
fs.mkdirSync(testDir, {recursive: true});

// Create test files
const existingFiles = [];
for (let i = 0; i < 10; i++) {
	const filePath = path.join(testDir, `existing-file-${i}.txt`);
	fs.writeFileSync(filePath, 'test content');
	existingFiles.push(filePath);
}

// Create test directory
const existingDir = path.join(testDir, 'existing-dir');
fs.mkdirSync(existingDir);

console.log('='.repeat(60));
console.log('LOCATE-PATH PERFORMANCE BENCHMARKS');
console.log('='.repeat(60));

// Test scenarios
const scenarios = {
	'Small list (5 paths)': [
		'nonexistent-1.txt',
		'nonexistent-2.txt',
		'existing-file-0.txt',
		'nonexistent-3.txt',
		'nonexistent-4.txt',
	],
	'Medium list (20 paths)': Array.from({length: 20}, (_, i) =>
		i === 10 ? 'existing-file-1.txt' : `nonexistent-${i}.txt`
	),
	'Large list (100 paths)': Array.from({length: 100}, (_, i) =>
		i === 50 ? 'existing-file-2.txt' : `nonexistent-${i}.txt`
	),
	'All existing paths (10 paths)': Array.from({length: 10}, (_, i) => `existing-file-${i}.txt`),
	'All nonexistent paths (10 paths)': Array.from({length: 10}, (_, i) => `nonexistent-${i}.txt`),
};

const results = [];

// Run benchmarks for each scenario
for (const [scenarioName, paths] of Object.entries(scenarios)) {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`Scenario: ${scenarioName}`);
	console.log('='.repeat(60));

	// Test async with cache (first run - cold cache)
	const asyncColdResult = await benchmark(
		'Async with cache (cold)',
		async () => {
			await locatePath(paths, {cwd: testDir, useCache: true});
		},
		500
	);
	results.push(asyncColdResult);

	// Test async with cache (warm cache)
	const asyncWarmResult = await benchmark(
		'Async with cache (warm)',
		async () => {
			await locatePath(paths, {cwd: testDir, useCache: true});
		},
		1000
	);
	results.push(asyncWarmResult);

	// Test async without cache
	const asyncNoCacheResult = await benchmark(
		'Async without cache',
		async () => {
			await locatePath(paths, {cwd: testDir, useCache: false});
		},
		500
	);
	results.push(asyncNoCacheResult);

	console.log(`\n  Cache speedup: ${formatNumber(asyncWarmResult.opsPerSec / asyncNoCacheResult.opsPerSec)}x`);
	console.log(`  Warm vs Cold: ${formatNumber(asyncWarmResult.opsPerSec / asyncColdResult.opsPerSec)}x`);

	// Test sync with cache (first run - cold cache)
	const syncColdResult = await benchmark(
		'Sync with cache (cold)',
		() => {
			locatePathSync(paths, {cwd: testDir, useCache: true});
		},
		500
	);
	results.push(syncColdResult);

	// Test sync with cache (warm cache)
	const syncWarmResult = await benchmark(
		'Sync with cache (warm)',
		() => {
			locatePathSync(paths, {cwd: testDir, useCache: true});
		},
		1000
	);
	results.push(syncWarmResult);

	// Test sync without cache
	const syncNoCacheResult = await benchmark(
		'Sync without cache',
		() => {
			locatePathSync(paths, {cwd: testDir, useCache: false});
		},
		500
	);
	results.push(syncNoCacheResult);

	console.log(`\n  Cache speedup: ${formatNumber(syncWarmResult.opsPerSec / syncNoCacheResult.opsPerSec)}x`);
	console.log(`  Warm vs Cold: ${formatNumber(syncWarmResult.opsPerSec / syncColdResult.opsPerSec)}x`);
}

// Test absolute path optimization
console.log(`\n${'='.repeat(60)}`);
console.log('Absolute Path Optimization Test');
console.log('='.repeat(60));

const absolutePaths = existingFiles.slice(0, 5);
const relativePaths = absolutePaths.map(p => path.relative(testDir, p));

const absResult = await benchmark(
	'Absolute paths',
	async () => {
		await locatePath(absolutePaths, {useCache: false});
	},
	1000
);
results.push(absResult);

const relResult = await benchmark(
	'Relative paths',
	async () => {
		await locatePath(relativePaths, {cwd: testDir, useCache: false});
	},
	1000
);
results.push(relResult);

console.log(`\n  Absolute path speedup: ${formatNumber(absResult.opsPerSec / relResult.opsPerSec)}x`);

// Test negative caching effectiveness
console.log(`\n${'='.repeat(60)}`);
console.log('Negative Caching Test');
console.log('='.repeat(60));

const nonexistentPaths = Array.from({length: 10}, (_, i) => `nonexistent-${i}.txt`);

// First run (populate cache)
await benchmark(
	'First run (populate cache)',
	async () => {
		await locatePath(nonexistentPaths, {cwd: testDir, useCache: true});
	},
	100
);

// Second run (use cache)
const negCacheResult = await benchmark(
	'Second run (using negative cache)',
	async () => {
		await locatePath(nonexistentPaths, {cwd: testDir, useCache: true});
	},
	1000
);
results.push(negCacheResult);

const noCacheResult = await benchmark(
	'Without cache',
	async () => {
		await locatePath(nonexistentPaths, {cwd: testDir, useCache: false});
	},
	100
);
results.push(noCacheResult);

console.log(`\n  Negative cache speedup: ${formatNumber(negCacheResult.opsPerSec / noCacheResult.opsPerSec)}x`);

// Summary
console.log(`\n${'='.repeat(60)}`);
console.log('SUMMARY');
console.log('='.repeat(60));

const topPerformers = results
	.sort((a, b) => b.opsPerSec - a.opsPerSec)
	.slice(0, 5);

console.log('\nTop 5 Performers:');
topPerformers.forEach((result, index) => {
	console.log(`  ${index + 1}. ${result.name}: ${formatOpsPerSec(result.opsPerSec)}`);
});

// Cleanup
fs.rmSync(testDir, {recursive: true});

console.log(`\n${'='.repeat(60)}`);
console.log('Benchmark complete!');
console.log('='.repeat(60));
