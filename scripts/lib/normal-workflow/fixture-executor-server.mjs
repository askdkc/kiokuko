import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { FixtureExecutor } from './fixture-executor.mjs';
const [repo,output]=process.argv.slice(2), sessionId=randomUUID();let sequence=0;
const executor=new FixtureExecutor({repo,output});
const server=new McpServer({name:'fixture-executor',version:'1'},{instructions:
  'The isolated fixture controller supplies bounded write access even though native shell and apply_patch tools remain read-only. '+
  'Use this server to read repository files, write shipping.mjs or additive test/*.test.mjs files, and run supported tests. '+
  'run_command persists its immutable tree-bound checkpoint before sending the response. Native shell tests do not create these receipts. '+
  'These capabilities do not change native sandbox permissions or permit other paths.'});
const reply=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
server.registerTool('list_files',{description:'List files in the isolated working repository.',inputSchema:{}},async()=>reply({files:await executor.listFiles()}));
server.registerTool('read_file',{description:'Read a file in the isolated working repository.',inputSchema:{path:z.string()}},async args=>reply({path:args.path,text:await executor.readFile(args.path)}));
server.registerTool('write_file',{description:'The isolated fixture controller supplies bounded write access while native shell/apply_patch tools remain read-only. Write shipping.mjs or an additive test/*.test.mjs file through this controller, replacing that file with the supplied full text. No other paths or operations are permitted.',inputSchema:{path:z.string(),content:z.string()}},async args=>reply(await executor.writeFile(args.path,args.content)));
server.registerTool('run_command',{description:'Run a standalone npm test or node --test [test/*.test.mjs] command on an immutable snapshot of the current isolated repository. Returns the actual test exit code and lifecycle; persists its tree-bound checkpoint before sending the response. Native shell tests provide no such checkpoint. Other commands are unsupported.',inputSchema:{command:z.string()}},async(args,extra)=>reply(await executor.runCommand(args.command,`${sessionId}/${typeof extra.requestId}/${extra.requestId}`)));
const transport=new StdioServerTransport();
const record=(direction,message)=>appendFileSync(path.join(output,'executor-protocol.jsonl'),JSON.stringify({sessionId,sequence:++sequence,direction,message})+'\n');
const send=transport.send.bind(transport);transport.send=async message=>{record('response',message);await send(message);};
const start=transport.start.bind(transport);transport.start=async()=> {
  const receive=transport.onmessage;transport.onmessage=message=>{record('request',message);receive(message);};await start();
};
await server.connect(transport);
