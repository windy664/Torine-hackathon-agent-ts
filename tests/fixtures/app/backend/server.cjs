const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.cwd(), 'data.json');
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ name: 'Original' }));
http.createServer(async (req, res) => {
  if (req.url === '/api/value') {
    if (req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk;
      const value = JSON.parse(text);
      if (!value.name?.trim()) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Name is required' })); }
      fs.writeFileSync(file, JSON.stringify(value));
    }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(fs.readFileSync(file));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fs.readFileSync(path.join(__dirname, '../frontend/dist/index.html')));
}).listen(Number(process.env.PORT), '127.0.0.1');
