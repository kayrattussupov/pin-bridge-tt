export interface SellerNameSource {
  displayName: string;
  pinLegalName: string | null;
  pinName: string | null;
}

/**
 * The seller name (`user.name`) a connection's listings carry on Pin unless the listing brings its
 * own `contact.name`: the legal name of the Pin account, else its display name, else the name given
 * when the account was connected. The display name comes second on purpose: Pin seems to rewrite it
 * from the last listing, so a wrong name sent once would otherwise keep itself in place.
 */
export const sellerNameOf = (connection: SellerNameSource): string =>
  connection.pinLegalName || connection.pinName || connection.displayName;
