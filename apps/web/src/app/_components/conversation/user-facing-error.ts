/** An error whose message is localized, contains no server detail and is safe to show verbatim. */
export class UserFacingError extends Error {
  override readonly name = "UserFacingError";
}
