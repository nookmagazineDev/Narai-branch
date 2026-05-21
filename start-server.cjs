const { spawn } = require('child_process');
const fs = require('fs');

const out = fs.openSync('./server-out.log', 'a');
const err = fs.openSync('./server-err.log', 'a');

const child = spawn('cmd.exe', ['/c', 'npm.cmd run dev'], {
  detached: true,
  stdio: ['ignore', out, err]
});

child.unref();
console.log('Server started in background (PID: ' + child.pid + ')');
