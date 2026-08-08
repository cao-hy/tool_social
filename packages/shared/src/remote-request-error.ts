export type RemoteRequestPhase =
  | 'BEFORE_CONNECT'
  | 'CONNECTING'
  | 'SENDING_HEADERS'
  | 'SENDING_BODY'
  | 'AWAITING_RESPONSE'
  | 'READING_RESPONSE';

export class RemoteRequestError extends Error {
  constructor(
    message: string,
    readonly phase: RemoteRequestPhase,
    readonly requestMayHaveReachedRemote: boolean,
    cause?: unknown,
    readonly providerRequestId?: string,
  ) {
    super(message, { cause });
    this.name = 'RemoteRequestError';
  }
}
