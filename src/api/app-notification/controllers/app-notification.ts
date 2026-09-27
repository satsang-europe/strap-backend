/**
 * app-notification controller
 */

import { factories } from '@strapi/strapi';

const APP_NOTIFICATION_UID = 'api::app-notification.app-notification';
const ACTIVE_NOTIFICATION_LIMIT = 100;
const NOTIFICATION_LIFETIME_MS = 72 * 60 * 60 * 1000;

type ImageFormat = {
  url?: string;
  width?: number;
  height?: number;
};

type ImageAsset = ImageFormat & {
  alternativeText?: string | null;
  formats?: Record<string, ImageFormat> | null;
};

type DateTimeValue = string | Date | null | undefined;

type NotificationRecord = {
  documentId: string;
  title?: string;
  pushMessage?: string;
  body?: unknown;
  publishedAt?: DateTimeValue;
  scheduledFor?: DateTimeValue;
  coverImage?: ImageAsset | null;
  gallery?: ImageAsset[] | null;
};

const serializeImage = (image: ImageAsset | null | undefined) => {
  if (!image?.url) {
    return null;
  }

  const formats = Object.fromEntries(
    Object.entries(image.formats ?? {}).flatMap(([name, format]) =>
      format?.url
        ? [[name, { url: format.url, width: format.width, height: format.height }]]
        : []
    )
  );

  return {
    url: image.url,
    alternativeText: image.alternativeText ?? null,
    width: image.width,
    height: image.height,
    formats,
  };
};

const toTimestamp = (value: DateTimeValue) => {
  if (value instanceof Date) {
    return value.getTime();
  }

  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
};

const getActiveWindow = (
  notification: { publishedAt?: DateTimeValue; scheduledFor?: DateTimeValue }
) => {
  const activeAt = toTimestamp(notification.scheduledFor ?? notification.publishedAt);

  if (!Number.isFinite(activeAt)) {
    return null;
  }

  return {
    activeAt,
    expiresAt: activeAt + NOTIFICATION_LIFETIME_MS,
  };
};

const isActive = (notification: NotificationRecord, now: number) => {
  const window = getActiveWindow(notification);

  return Boolean(window && window.activeAt <= now && window.expiresAt > now);
};

const serializeListItem = (notification: NotificationRecord) => {
  const window = getActiveWindow(notification);

  return {
    documentId: notification.documentId,
    title: notification.title,
    pushMessage: notification.pushMessage,
    activeAt: window ? new Date(window.activeAt).toISOString() : null,
    expiresAt: window ? new Date(window.expiresAt).toISOString() : null,
    coverImage: serializeImage(notification.coverImage),
  };
};

const serializeDetail = (notification: NotificationRecord) => ({
  ...serializeListItem(notification),
  body: notification.body ?? null,
  gallery: Array.isArray(notification.gallery)
    ? notification.gallery.map(serializeImage).filter(Boolean)
    : [],
});

export default factories.createCoreController(APP_NOTIFICATION_UID, ({ strapi }) => ({
  async findActive(ctx) {
    const now = new Date();
    const activeAfter = new Date(now.getTime() - NOTIFICATION_LIFETIME_MS).toISOString();
    const notifications = await strapi.documents(APP_NOTIFICATION_UID).findMany({
      status: 'published',
      filters: {
        $or: [
          {
            scheduledFor: {
              $notNull: true,
              $lte: now.toISOString(),
              $gt: activeAfter,
            },
          },
          {
            scheduledFor: { $null: true },
            publishedAt: {
              $lte: now.toISOString(),
              $gt: activeAfter,
            },
          },
        ],
      },
      limit: ACTIVE_NOTIFICATION_LIMIT,
      populate: {
        coverImage: true,
      },
    });

    const data = notifications
      .filter((notification) => isActive(notification, now.getTime()))
      .sort((left, right) => {
        const leftActiveAt = getActiveWindow(left)?.activeAt ?? 0;
        const rightActiveAt = getActiveWindow(right)?.activeAt ?? 0;

        return rightActiveAt - leftActiveAt;
      })
      .map(serializeListItem);

    ctx.set('Cache-Control', 'no-store');
    ctx.body = {
      data,
      meta: { count: data.length },
    };
  },

  async findActiveOne(ctx) {
    const notification = await strapi.documents(APP_NOTIFICATION_UID).findOne({
      documentId: ctx.params.documentId,
      status: 'published',
      populate: {
        coverImage: true,
        gallery: true,
      },
    });

    if (!notification || !isActive(notification, Date.now())) {
      return ctx.notFound('Notification not found');
    }

    ctx.set('Cache-Control', 'no-store');
    ctx.body = { data: serializeDetail(notification) };
  },
}));
