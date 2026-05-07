function mapDockerInterfaceErrorToUiMessage(error) {
  const code = (error && typeof error === 'object' && error.code) ? String(error.code) : '';
  const msg = (error && typeof error === 'object' && typeof error.message === 'string') ? error.message : '';

  if (msg && /port is already allocated/i.test(msg)) {
    return 'That port is already in use. Choose different ports and try again.';
  }

  // Keep messages non-technical. Any technical troubleshooting belongs in a dedicated help surface.
  switch (code) {
    case 'PERMISSION_DENIED':
      return 'Permission denied. Please ensure the required runtime is accessible and try again.';
    case 'DAEMON_UNAVAILABLE':
      return 'The required runtime is not running. Please start it and try again.';
    case 'DOCKER_NOT_FOUND':
    case 'DOCKERODE_MISSING':
      return 'The required runtime is not available. Please install it and try again.';
    case 'INVALID_DOCKER_HOST':
      return 'The runtime configuration is invalid. Please check your environment settings and try again.';

    case 'REGISTRY_RATE_LIMIT':
      return 'Update checks are temporarily unavailable. Please try again later.';
    case 'REGISTRY_AUTH_FAILED':
      return 'Update checks are unavailable. Please try again later.';
    case 'REGISTRY_ERROR':
    case 'REGISTRY_NO_DIGEST':
      return 'Update checks are unavailable right now. Please try again later.';

    case 'GITHUB_API_ERROR':
    case 'GITHUB_PAGINATION_ERROR':
      return 'Update checks are unavailable right now. Please try again later.';

    case 'OP_IN_PROGRESS':
      return 'Another operation is already running. Please wait for it to finish.';
    case 'OP_NOT_FOUND':
      return 'No operation is currently running.';
    case 'INVALID_OP_ID':
    case 'INVALID_CONTAINER_ID':
      return 'Invalid request.';
    case 'INVALID_RETENTION_POLICY':
      return 'Invalid retention setting.';
    case 'INVALID_PORT_PREFERENCES':
      return 'Invalid port settings. Use three different ports (1-65535).';
    case 'INVALID_DATA_LOSS_ACK':
      return 'Please confirm the warning to continue.';
    case 'NOT_INSTALLED':
      return 'This version is not installed yet.';
    case 'NOT_YET_AVAILABLE':
      return 'This version is not available yet. Please try again later.';
    case 'INSTANCE_NOT_FOUND':
      return 'Instance not found.';
    case 'CANNOT_DELETE_ACTIVE':
      return 'You cannot delete the active instance.';
    case 'NO_RELEASES':
      return 'No official versions are available right now.';
    case 'NO_ACTIVE_INSTANCE':
      return 'No active instance is available.';
    case 'CREATE_FAILED':
      return 'Unable to start the selected version.';
    case 'CONFLICT':
      return 'Unable to start due to a conflict (ports or name already in use).';
    case 'INVALID_TAG':
    case 'TAG_NOT_ALLOWED':
      return 'That version is not supported.';

    case 'NOT_IMPLEMENTED':
      return 'This action is not available yet.';

    default:
      return '';
  }
}

function toErrorResponse(error) {
  const code = (error && typeof error === 'object' && error.code) ? String(error.code) : undefined;
  const friendly = mapDockerInterfaceErrorToUiMessage(error);
  const message =
    friendly ||
    (error && typeof error === 'object' && typeof error.message === 'string' && error.message) ||
    'Unexpected error';

  const payload = { message };
  if (code) payload.code = code;
  return payload;
}

module.exports = {
  mapDockerInterfaceErrorToUiMessage,
  toErrorResponse
};
