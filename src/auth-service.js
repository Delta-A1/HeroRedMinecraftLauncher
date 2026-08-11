'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  InteractionRequiredAuthError,
  PublicClientApplication
} = require('@azure/msal-node');
const { MicrosoftAuthenticator, MojangClient } = require('@xmcl/user');
const { ensureDirectory, readJson, writeJsonAtomic } = require('./file-utils');

const MICROSOFT_SCOPES = Object.freeze(['XboxLive.signin', 'offline_access']);

function getXboxClaim(response) {
  return response?.DisplayClaims?.xui?.[0] || {};
}

async function exchangeMicrosoftTokenForMinecraft(accessToken, authenticator, mojang) {
  const xboxLive = await authenticator.authenticateXboxLive(accessToken);
  const minecraftXsts = await authenticator.authorizeXboxLive(
    xboxLive.Token,
    'rp://api.minecraftservices.com/'
  );
  const claim = getXboxClaim(minecraftXsts);
  const minecraftAuth = await authenticator.loginMinecraftWithXBox(claim.uhs, minecraftXsts.Token);
  let xuid = String(
    claim.xid
    || getXboxClaim(xboxLive).xid
    || (/^\d+$/.test(String(minecraftAuth.username || '')) ? minecraftAuth.username : '')
    || ''
  ).trim();
  if (!/^\d+$/.test(xuid)) {
    const liveXsts = await authenticator.authorizeXboxLive(
      xboxLive.Token,
      'http://xboxlive.com'
    );
    xuid = String(getXboxClaim(liveXsts).xid || '').trim();
  }
  if (!/^\d+$/.test(xuid)) {
    const error = new Error('Xbox XUID를 확인하지 못했습니다. Microsoft 계정을 로그아웃한 뒤 다시 연결해 주세요.');
    error.code = 'MINECRAFT_XUID_REQUIRED';
    throw error;
  }
  const [ownership, profile] = await Promise.all([
    mojang.checkGameOwnership(minecraftAuth.access_token),
    mojang.getProfile(minecraftAuth.access_token)
  ]);
  if (!Array.isArray(ownership?.items) || !ownership.items.length) {
    const error = new Error('이 Microsoft 계정에서 Minecraft: Java Edition 소유권을 확인하지 못했습니다.');
    error.code = 'MINECRAFT_OWNERSHIP_REQUIRED';
    throw error;
  }
  const activeSkin = Array.isArray(profile?.skins)
    ? (profile.skins.find((skin) => skin?.state === 'ACTIVE') || profile.skins[0])
    : null;
  return {
    accessToken: minecraftAuth.access_token,
    expiresIn: minecraftAuth.expires_in,
    xuid,
    profile: {
      id: profile.id,
      name: profile.name,
      skin: activeSkin?.url
        ? {
            url: activeSkin.url,
            variant: String(activeSkin.variant || 'CLASSIC').toUpperCase() === 'SLIM'
              ? 'SLIM'
              : 'CLASSIC'
          }
        : null
    }
  };
}

class AuthConfigurationError extends Error {
  constructor(message = 'Microsoft 로그인 설정이 완료되지 않았습니다.') {
    super(message);
    this.name = 'AuthConfigurationError';
    this.code = 'AUTH_CONFIGURATION_REQUIRED';
  }
}

class AuthRequiredError extends Error {
  constructor(message = 'Microsoft 계정 로그인이 필요합니다.') {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = 'AUTH_REQUIRED';
  }
}

class AuthService {
  constructor(options) {
    this.clientId = options.clientId;
    this.cacheFile = options.cacheFile;
    this.profileFile = options.profileFile;
    this.safeStorage = options.safeStorage;
    this.openExternal = options.openExternal;
    this.onDeviceCode = options.onDeviceCode;
    this.onMicrosoftAuthenticated = options.onMicrosoftAuthenticated;
    this.pca = null;
    this.initialized = false;
  }

  get configured() {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(this.clientId || '');
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.configured) return;
    this.pca = new PublicClientApplication({
      auth: {
        clientId: this.clientId,
        authority: 'https://login.microsoftonline.com/consumers'
      },
      system: {
        loggerOptions: {
          piiLoggingEnabled: false,
          logLevel: 0
        }
      }
    });
    await this.restoreTokenCache();
  }

  async restoreTokenCache() {
    if (!this.pca || !this.safeStorage?.isEncryptionAvailable?.()) return;
    try {
      const encrypted = await fs.readFile(this.cacheFile);
      const serialized = this.safeStorage.decryptString(encrypted);
      if (serialized) this.pca.getTokenCache().deserialize(serialized);
    } catch {
      // A missing or machine-bound unreadable cache simply requires login again.
    }
  }

  async persistTokenCache() {
    if (!this.pca || !this.safeStorage?.isEncryptionAvailable?.()) return;
    await ensureDirectory(path.dirname(this.cacheFile));
    const serialized = this.pca.getTokenCache().serialize();
    const encrypted = this.safeStorage.encryptString(serialized);
    const temp = `${this.cacheFile}.partial`;
    await fs.writeFile(temp, encrypted);
    await fs.rm(this.cacheFile, { force: true });
    await fs.rename(temp, this.cacheFile);
  }

  async getAccounts() {
    await this.initialize();
    if (!this.pca) return [];
    return this.pca.getTokenCache().getAllAccounts();
  }

  async getStatus() {
    await this.initialize();
    const accounts = await this.getAccounts();
    const profile = await readJson(this.profileFile, null);
    const microsoftSignedIn = accounts.length > 0;
    const minecraftReady = Boolean(
      microsoftSignedIn
      && typeof profile?.id === 'string'
      && profile.id
      && typeof profile?.name === 'string'
      && profile.name
    );
    return {
      configured: this.configured,
      signedIn: minecraftReady,
      microsoftSignedIn,
      minecraftReady,
      microsoftName: accounts[0]?.username || '',
      minecraftName: minecraftReady ? profile.name : '',
      minecraftId: minecraftReady ? profile.id : '',
      skinVariant: minecraftReady && profile?.skin?.variant === 'SLIM' ? 'SLIM' : 'CLASSIC',
      skinAvailable: Boolean(minecraftReady && profile?.skin?.url),
      secureStorage: Boolean(this.safeStorage?.isEncryptionAvailable?.())
    };
  }

  async getStoredProfile() {
    return readJson(this.profileFile, null);
  }

  async acquireMicrosoftToken(interactive) {
    await this.initialize();
    if (!this.pca) throw new AuthConfigurationError();
    const accounts = await this.getAccounts();
    if (accounts[0]) {
      try {
        const result = await this.pca.acquireTokenSilent({
          account: accounts[0],
          scopes: MICROSOFT_SCOPES
        });
        await this.persistTokenCache();
        return result;
      } catch (error) {
        if (!(error instanceof InteractionRequiredAuthError) && !/interaction_required|invalid_grant/i.test(error?.errorCode || error?.message || '')) {
          throw error;
        }
      }
    }
    if (!interactive) throw new AuthRequiredError();

    const result = await this.pca.acquireTokenByDeviceCode({
      scopes: MICROSOFT_SCOPES,
      deviceCodeCallback: (response) => {
        const verificationUri = response.verificationUri || 'https://microsoft.com/devicelogin';
        this.onDeviceCode?.({
          userCode: response.userCode,
          verificationUri,
          message: response.message,
          expiresIn: response.expiresIn
        });
        Promise.resolve(this.openExternal?.(verificationUri)).catch(() => {});
      }
    });
    if (!result?.accessToken) throw new AuthRequiredError('Microsoft 로그인이 취소되었거나 완료되지 않았습니다.');
    await this.persistTokenCache();
    await this.onMicrosoftAuthenticated?.({
      username: result.account?.username || ''
    });
    return result;
  }

  async acquireMinecraftSession(options = {}) {
    const msResult = await this.acquireMicrosoftToken(Boolean(options.interactive));
    const authenticator = new MicrosoftAuthenticator({ fetch });
    const mojang = new MojangClient({ fetch });
    const session = await exchangeMicrosoftTokenForMinecraft(
      msResult.accessToken,
      authenticator,
      mojang
    );
    await writeJsonAtomic(this.profileFile, {
      id: session.profile.id,
      name: session.profile.name,
      skin: session.profile.skin,
      verifiedAt: new Date().toISOString()
    });
    return {
      ...session,
      clientId: this.clientId
    };
  }

  async login() {
    const session = await this.acquireMinecraftSession({ interactive: true });
    return {
      profile: session.profile,
      status: await this.getStatus()
    };
  }

  async logout() {
    await this.initialize();
    if (this.pca) {
      const accounts = await this.getAccounts();
      for (const account of accounts) {
        await this.pca.getTokenCache().removeAccount(account);
      }
    }
    await fs.rm(this.cacheFile, { force: true });
    await fs.rm(this.profileFile, { force: true });
    return this.getStatus();
  }
}

module.exports = {
  AuthConfigurationError,
  AuthRequiredError,
  AuthService,
  MICROSOFT_SCOPES,
  exchangeMicrosoftTokenForMinecraft
};
