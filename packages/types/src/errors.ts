/** Base class for every error HyperPay throws deliberately. */
export class HyperPayError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * A spend rule rejected the payment. Thrown *before* anything is signed, so no
 * transaction exists and nothing can settle.
 */
export class PolicyError extends HyperPayError {}

/** The payments API returned a non-2xx response or an `{ error: ... }` body. */
export class ApiError extends HyperPayError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly endpoint?: string,
  ) {
    super(message)
  }
}

/** The transaction was submitted but never confirmed within its blockhash validity window. */
export class ConfirmationError extends HyperPayError {
  constructor(message: string, readonly signature?: string) {
    super(message)
  }
}

/** A token, mint or recipient could not be resolved to something payable. */
export class ResolutionError extends HyperPayError {}

/** No signer is available, or the configured signer refused to sign. */
export class SignerError extends HyperPayError {}
