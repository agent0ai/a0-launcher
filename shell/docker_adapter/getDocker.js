async function getDocker(options = {}) {
  const { DockerInterface } = await import('./DockerInterface.mjs');
  return DockerInterface.get(options);
}

module.exports = { getDocker };

