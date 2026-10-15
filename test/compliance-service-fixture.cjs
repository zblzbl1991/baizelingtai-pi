// Separate process for hard-restart behavior. Only synthetic identity paths are
// supplied by the parent test; no user defaults or provider credentials inherit.
const http = require('node:http'), path = require('node:path');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const agent = process.env.PI_CODING_AGENT_DIR;
const access = new WorkspaceAccessService({ filePath:path.join(agent,'access.json'),envToken:()=> 'synthetic-scans' });
const gateway = createPiAgentGateway({accessService:access,deferredFilePath:path.join(agent,'deferred.json'),cronFilePath:path.join(agent,'cron.sqlite')});
const app = require('express')();access.mount(app);app.use(require('express').json({limit:'32mb'}));gateway.mount(app);
const server = http.createServer(app);server.listen(0,'127.0.0.1',()=>process.send({origin:`http://127.0.0.1:${server.address().port}`}));
process.on('message',async message=>{if(message==='close'){await gateway.dispose();access.dispose();server.closeAllConnections();server.close(()=>process.exit(0));}});
