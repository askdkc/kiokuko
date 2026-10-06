import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {firstSetupEnvironment}=await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/package-smoke-environment.mjs')).href);
test('optional first setup confines home, application data and npm configuration to the disposable fixture',()=>{
  const root=path.resolve('/tmp/kiokuko-first-setup'),prefix=path.join(root,'prefix');
  const inherited={HOME:'/not-the-fixture',USERPROFILE:'/not-the-fixture',XDG_DATA_HOME:'/not-the-fixture',XDG_CONFIG_HOME:'/not-the-fixture',KIOKUKO_DATA_DIR:'/not-the-fixture',NPM_CONFIG_PREFIX:'/not-the-fixture',NPM_CONFIG_CACHE:'/not-the-fixture',NPM_CONFIG_USERCONFIG:'/not-the-fixture',npm_config_globalconfig:'/not-the-fixture',PATH:'/bin',ONNXRUNTIME_NODE_INSTALL:'skip'};
  const environment=firstSetupEnvironment(root,prefix,inherited);
  for(const key of ['HOME','USERPROFILE','XDG_DATA_HOME','XDG_CONFIG_HOME','KIOKUKO_DATA_DIR','npm_config_cache','npm_config_userconfig','npm_config_globalconfig']) assert.ok(environment[key].startsWith(root+path.sep),key);
  assert.equal(environment.npm_config_prefix,prefix);
  for(const key of ['NPM_CONFIG_PREFIX','NPM_CONFIG_CACHE','NPM_CONFIG_USERCONFIG']) assert.equal(environment[key],undefined);
  assert.equal(environment.ONNXRUNTIME_NODE_INSTALL,'skip');
  assert.equal(environment.PATH,`${path.join(root,'bin')}${path.delimiter}/bin`);
  assert.equal(inherited.HOME,'/not-the-fixture','do not mutate the parent environment');
});
