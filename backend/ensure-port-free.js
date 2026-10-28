const { execSync } = require('child_process');

const port = Number(process.argv[2] || 5001);

if (!Number.isInteger(port) || port <= 0) {
  console.error('无效端口:', process.argv[2]);
  process.exit(1);
}

function getCommandOutput(command) {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (error) {
    return '';
  }
}

function getPidsByPort(targetPort) {
  if (process.platform === 'win32') {
    const output = getCommandOutput(`netstat -ano | findstr :${targetPort}`);
    return Array.from(new Set(
      output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => line.includes('LISTENING'))
        .map(line => {
          const parts = line.split(/\s+/);
          return parts[parts.length - 1];
        })
        .filter(Boolean)
        .map(pid => Number(pid))
        .filter(pid => Number.isInteger(pid) && pid > 0)
    ));
  }

  const output = getCommandOutput(`lsof -ti tcp:${targetPort}`);
  return Array.from(new Set(
    output
      .split(/\r?\n/)
      .map(line => Number(line.trim()))
      .filter(pid => Number.isInteger(pid) && pid > 0)
  ));
}

function killPid(pid) {
  if (pid === process.pid) return;

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    }
    console.log(`已释放端口 ${port}，结束进程 PID=${pid}`);
  } catch (error) {
    console.warn(`结束 PID=${pid} 失败，继续启动。`);
  }
}

const pids = getPidsByPort(port);

if (!pids.length) {
  console.log(`端口 ${port} 当前空闲，无需清理。`);
  process.exit(0);
}

pids.forEach(killPid);
