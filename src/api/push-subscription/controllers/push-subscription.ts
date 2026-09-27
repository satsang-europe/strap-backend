import { factories } from '@strapi/strapi';

const PUSH_SUBSCRIPTION_UID = 'api::push-subscription.push-subscription';
const EXPO_PUSH_TOKEN_PATTERN = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/;

type RegistrationBody = {
  platform?: unknown;
  token?: unknown;
};

function parseRegistrationBody(body: RegistrationBody | undefined) {
  const token = body?.token;
  const platform = body?.platform;

  if (
    typeof token !== 'string' ||
    token.length > 256 ||
    !EXPO_PUSH_TOKEN_PATTERN.test(token)
  ) {
    return null;
  }

  if (platform !== 'ios' && platform !== 'android') {
    return null;
  }

  return { platform, token } as const;
}

export default factories.createCoreController(PUSH_SUBSCRIPTION_UID, ({ strapi }) => ({
  async register(ctx) {
    const registration = parseRegistrationBody(ctx.request.body as RegistrationBody);

    if (!registration) {
      return ctx.badRequest('A valid Expo push token and platform are required');
    }

    const existing = await strapi.db.query(PUSH_SUBSCRIPTION_UID).findOne({
      where: { token: registration.token },
    });
    const data = {
      enabled: true,
      lastSeenAt: new Date().toISOString(),
      platform: registration.platform,
    };

    if (existing) {
      await strapi.db.query(PUSH_SUBSCRIPTION_UID).update({
        data,
        where: { id: existing.id },
      });
    } else {
      await strapi.db.query(PUSH_SUBSCRIPTION_UID).create({
        data: { ...data, token: registration.token },
      });
    }

    ctx.set('Cache-Control', 'no-store');
    ctx.body = { data: { registered: true } };
  },

  async unregister(ctx) {
    const registration = parseRegistrationBody(ctx.request.body as RegistrationBody);

    if (!registration) {
      return ctx.badRequest('A valid Expo push token and platform are required');
    }

    const existing = await strapi.db.query(PUSH_SUBSCRIPTION_UID).findOne({
      where: { token: registration.token },
    });

    if (existing) {
      await strapi.db.query(PUSH_SUBSCRIPTION_UID).update({
        data: {
          enabled: false,
          lastSeenAt: new Date().toISOString(),
          platform: registration.platform,
        },
        where: { id: existing.id },
      });
    }

    ctx.set('Cache-Control', 'no-store');
    ctx.body = { data: { registered: false } };
  },
}));
