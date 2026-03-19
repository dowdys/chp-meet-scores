---
title: Electron safeStorage needs prefix marker to prevent double-encryption
category: runtime-errors
date: 2026-03-19
component: src/main/config-store.ts
severity: high
tags: [electron, security, encryption, safestorage, dpapi, config]
---

## Problem

API keys stored with Electron's `safeStorage.encryptString()` can become permanently corrupted (double-encrypted) if the OS keychain is temporarily unavailable during a read operation.

## Root Cause

The naive migration approach tries to decrypt every value and checks if the result equals the stored value:

```typescript
// WRONG: Can't distinguish "plaintext" from "encrypted but keychain unavailable"
const decrypted = this.decryptValue(value);
if (decrypted === value) {
  // Assumes plaintext — re-encrypts it
  this.store.set(key, this.encryptValue(value));
}
```

When `safeStorage.decryptString()` fails (e.g., Windows DPAPI keychain locked while screen is locked, or keychain agent restarting), the catch block returns the raw encrypted blob unchanged. The migration logic sees `decrypted === value` (both are the encrypted blob), concludes it's "plaintext that needs migration," and encrypts the already-encrypted blob. The next successful read decrypts once, producing the *first* encrypted blob — which is garbage, not the original API key.

This is a TOCTOU race between the keychain availability check and the encrypt/decrypt operations.

## Solution

Add a deterministic prefix (`enc:`) to encrypted values so the system can always distinguish encrypted from plaintext without attempting decryption:

```typescript
private encryptValue(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  }
  return value; // Fallback to plaintext
}

private decryptValue(encrypted: string): string {
  if (encrypted.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted.slice(4), 'base64'));
    } catch {
      return encrypted; // Return as-is if decryption fails (keychain unavailable)
    }
  }
  return encrypted; // Not encrypted — plaintext or encryption unavailable
}
```

Migration happens naturally: unprefixed values are treated as plaintext and re-encrypted with the prefix on next write. The prefix check is a pure string operation — no keychain access needed.

## Prevention

When implementing at-rest encryption with OS keychain APIs:
1. **Never use "try decrypt, check if changed" as a plaintext detector** — decryption can fail silently
2. **Always mark encrypted values** with a prefix, version byte, or magic number
3. **Handle keychain unavailability gracefully** — return the encrypted blob and retry later, don't assume plaintext
4. **Test with screen locked / keychain agent stopped** — these are the edge cases that trigger the race
