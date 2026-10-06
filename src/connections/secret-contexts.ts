/** Encryption contexts of a connection's Pin credentials (binds each ciphertext to its row). */
export const deviceKeyContext = (connectionId: string) => `connection:${connectionId}:device_key`;
export const tokenContext = (connectionId: string) => `connection:${connectionId}:token`;
