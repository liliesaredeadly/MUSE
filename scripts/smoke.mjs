// Read-only checks against the running production server. No projects are created.
import assert from 'node:assert/strict';

const base = process.env.MUSE_SMOKE_URL || 'http://127.0.0.1:3001';
const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200);
assert.equal((await health.json()).storage, 'sqlite');
const producerStatus = await fetch(`${base}/api/producer/status`);
assert.equal(producerStatus.status, 200);
const producer = await producerStatus.json();
assert.ok(['rules', 'ai'].includes(producer.mode));
assert.deepEqual(Object.keys(producer).sort(), ['mode', 'model', 'provider']);
const index = await fetch(base);
assert.equal(index.status, 200);
assert.match(index.headers.get('content-type'), /text\/html/);
const html = await index.text();
assert.match(html, /<title>MUSE/);
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
assert.ok(assets.length >= 2, 'Expected built JavaScript and CSS assets.');
for (const asset of assets) {
  const response = await fetch(new URL(asset, base));
  assert.equal(response.status, 200, `Missing built asset: ${asset}`);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
}
assert.equal((await fetch(`${base}/studio`)).status, 200, 'SPA deep link must serve the app.');
assert.equal((await fetch(`${base}/server/app.js`)).status, 404, 'Source must not be exposed.');
const projects = await fetch(`${base}/api/projects`);
assert.equal(projects.status, 200);
assert.ok(Array.isArray((await projects.json()).projects));
console.log(`PASS: SQLite health, producer configuration, production HTML, ${assets.length} built assets, SPA route, source containment and project read API.`);
