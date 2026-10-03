import type { Command } from 'commander';
import { runTunnel, tunnelStatus, type TunnelOptions } from '../chatgpt/tunnel-runner.js';
export function registerChatgptCommands(cli: Command): void {
  const chatgpt = cli.command('chatgpt').description('Run and inspect the managed ChatGPT tunnel connection');
  const options = (command: Command) => command.option('--profile <name>', 'Tunnel profile', 'kiokuko-chatgpt').option('--profile-dir <path>', 'Tunnel profile directory').option('--tunnel-client <path>', 'Tunnel client executable');
  options(chatgpt.command('run').description('Run the tunnel in the foreground with bounded diagnostics')).action(runTunnel);
  options(chatgpt.command('status').description('Inspect the current tunnel diagnostics')).option('--json').action(async (value: TunnelOptions & { json?: boolean }) => {
    const status = await tunnelStatus(value);
    process.stdout.write(JSON.stringify(status) + '\n');
  });
}
