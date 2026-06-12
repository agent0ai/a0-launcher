async function getDocker(options = {}) {
  const { DockerInterface } = await import('./DockerInterface.mjs');
  return DockerInterface.get(options);
}

async function resetDocker() {
  const { DockerInterface } = await import('./DockerInterface.mjs');
  DockerInterface.reset();
}

module.exports = { getDocker, resetDocker };
