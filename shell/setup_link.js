// This protocol opens local guidance only. It carries no server, code or grant.
function isSetupLink(value) {
  return value === 'a0-launcher://setup' || value === 'a0-launcher://setup/';
}

function setupLinkFromArguments(args) {
  return Array.isArray(args) && args.some(isSetupLink);
}

module.exports = { isSetupLink, setupLinkFromArguments };
