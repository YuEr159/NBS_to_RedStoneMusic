// Usage: node fetchgh.js <user> <repo> <branch> <path> <outfile>
const fs = require('fs');
const https = require('https');

const [user, repo, branch, path, out] = process.argv.slice(2);

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'research-agent', 'Accept': 'application/vnd.github+json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
  });
}

(async () => {
  const url = `https://api.github.com/repos/${user}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const r = await get(url);
  if (r.status !== 200) {
    console.error(`HTTP ${r.status}: ${r.body.slice(0, 300)}`);
    process.exit(1);
  }
  const j = JSON.parse(r.body);
  const buf = Buffer.from(j.content, 'base64');
  fs.writeFileSync(out, buf);
  console.log(`OK ${out} (${buf.length} bytes) sha=${j.sha}`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
