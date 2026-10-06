import path from 'node:path';

// First setup must not read or create application data in the invoking user's
// home, and inherited npm settings must not redirect its disposable prefix.
export function firstSetupEnvironment(fixtureRoot, prefixDirectory, inherited = process.env) {
  const environment = {...inherited};
  for (const key of Object.keys(environment)) {
    if (/^npm_config_(?:prefix|cache|userconfig|globalconfig)$/iu.test(key)) delete environment[key];
  }
  return {
    ...environment,
    HOME: path.join(fixtureRoot, 'home'),
    USERPROFILE: path.join(fixtureRoot, 'home'),
    XDG_DATA_HOME: path.join(fixtureRoot, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(fixtureRoot, 'config'),
    KIOKUKO_DATA_DIR: path.join(fixtureRoot, 'data'),
    PATH: `${path.join(fixtureRoot, 'bin')}${path.delimiter}${inherited.PATH ?? ''}`,
    npm_config_prefix: prefixDirectory,
    npm_config_cache: path.join(fixtureRoot, 'npm-cache'),
    npm_config_userconfig: path.join(fixtureRoot, 'empty-user-npmrc'),
    npm_config_globalconfig: path.join(fixtureRoot, 'empty-global-npmrc'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}
