import { RemoteRequestError, type RemoteRequestPhase } from '@socialhub/shared';
import { isPlatformError } from './platform-error';

export async function markRemoteMutationBoundary<T>(
  request: () => Promise<T>,
  input: {
    phase?: RemoteRequestPhase;
    providerRequestId?: string;
  } = {},
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (isPlatformError(error) && error.kind === 'PLATFORM_ERROR') {
      throw new RemoteRequestError(
        error.message,
        input.phase ?? 'AWAITING_RESPONSE',
        true,
        error,
        input.providerRequestId,
      );
    }
    throw error;
  }
}
