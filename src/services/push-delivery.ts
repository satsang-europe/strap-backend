import type { Core } from '@strapi/strapi';

const APP_NOTIFICATION_UID = 'api::app-notification.app-notification';
const PUSH_DELIVERY_UID = 'api::push-delivery.push-delivery';
const PUSH_SUBSCRIPTION_UID = 'api::push-subscription.push-subscription';

const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;
const SUBSCRIPTION_PAGE_SIZE = 500;
const DELIVERY_BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const NOTIFICATION_LIFETIME_SECONDS = 72 * 60 * 60;
const NOTIFICATION_LIFETIME_MS = NOTIFICATION_LIFETIME_SECONDS * 1000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

type DateTimeValue = string | Date | null | undefined;

type PublishedNotification = {
  documentId?: string;
  title?: string;
  pushMessage?: string;
  publishedAt?: DateTimeValue;
  scheduledFor?: DateTimeValue;
};

type PushDelivery = {
  id: number;
  notificationDocumentId: string;
  title: string;
  pushMessage: string;
  activeAt: string;
  attempts?: number;
  ticketErrors?: StoredTicketError[] | null;
  ticketIds?: StoredTicket[] | null;
};

type PushSubscription = {
  id: number;
  token: string;
};

type ExpoPushTicket = {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
};

type ExpoPushResponse = {
  data?: ExpoPushTicket | ExpoPushTicket[];
  errors?: Array<{ code?: string; message?: string }>;
};

type StoredTicket = {
  id: string;
  token: string;
};

type StoredTicketError = {
  error: string | null;
  message: string;
  token: string;
};

let workerRunning = false;

const query = (strapi: Core.Strapi, uid: string) =>
  strapi.db.query(uid as never) as any;

const toIsoDate = (value: DateTimeValue) => {
  const date = value instanceof Date ? value : new Date(value ?? '');

  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const getExpoHeaders = () => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return headers;
};

const disableSubscription = async (strapi: Core.Strapi, subscriptionId: number) => {
  await query(strapi, PUSH_SUBSCRIPTION_UID).update({
    data: { enabled: false },
    where: { id: subscriptionId },
  });
};

const fetchEnabledSubscriptions = async (strapi: Core.Strapi) => {
  const subscriptions: PushSubscription[] = [];
  let offset = 0;

  while (true) {
    const page = (await query(strapi, PUSH_SUBSCRIPTION_UID).findMany({
      limit: SUBSCRIPTION_PAGE_SIZE,
      offset,
      orderBy: { id: 'asc' },
      select: ['id', 'token'],
      where: { enabled: true },
    })) as PushSubscription[];

    subscriptions.push(...page);

    if (page.length < SUBSCRIPTION_PAGE_SIZE) {
      return subscriptions;
    }

    offset += page.length;
  }
};

const sendDelivery = async (strapi: Core.Strapi, delivery: PushDelivery) => {
  const tickets: StoredTicket[] = Array.isArray(delivery.ticketIds)
    ? [...delivery.ticketIds]
    : [];
  const ticketErrors: StoredTicketError[] = Array.isArray(delivery.ticketErrors)
    ? [...delivery.ticketErrors]
    : [];
  const processedTokens = new Set([
    ...tickets.map((ticket) => ticket.token),
    ...ticketErrors.map((ticketError) => ticketError.token),
  ]);
  const subscriptions = (await fetchEnabledSubscriptions(strapi)).filter(
    (subscription) => !processedTokens.has(subscription.token)
  );
  const activeAtMs = new Date(delivery.activeAt).getTime();
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - activeAtMs) / 1000));
  const ttl = Math.max(1, NOTIFICATION_LIFETIME_SECONDS - elapsedSeconds);

  for (const subscriptionBatch of chunk(subscriptions, EXPO_BATCH_SIZE)) {
    const response = await fetch(EXPO_SEND_URL, {
      body: JSON.stringify(
        subscriptionBatch.map((subscription) => ({
          body: delivery.pushMessage,
          channelId: 'satsang-updates',
          data: {
            notificationDocumentId: delivery.notificationDocumentId,
          },
          priority: 'high',
          sound: 'default',
          title: delivery.title,
          to: subscription.token,
          ttl,
        }))
      ),
      headers: getExpoHeaders(),
      method: 'POST',
    });
    const payload = (await response.json().catch(() => ({}))) as ExpoPushResponse;

    if (!response.ok) {
      const details = payload.errors?.map((error) => error.message).filter(Boolean).join('; ');
      throw new Error(`Expo push request failed (${response.status})${details ? `: ${details}` : ''}`);
    }

    const batchTickets = Array.isArray(payload.data)
      ? payload.data
      : payload.data
        ? [payload.data]
        : [];

    if (batchTickets.length !== subscriptionBatch.length) {
      throw new Error('Expo returned an unexpected number of push tickets');
    }

    for (let index = 0; index < batchTickets.length; index += 1) {
      const ticket = batchTickets[index];
      const subscription = subscriptionBatch[index];

      if (ticket.status === 'ok' && ticket.id) {
        tickets.push({ id: ticket.id, token: subscription.token });
        continue;
      }

      const error = ticket.details?.error ?? null;
      ticketErrors.push({
        error,
        message: ticket.message ?? 'Expo rejected this push notification',
        token: subscription.token,
      });

      if (error === 'DeviceNotRegistered') {
        await disableSubscription(strapi, subscription.id);
      }
    }

    await query(strapi, PUSH_DELIVERY_UID).update({
      data: { ticketErrors, ticketIds: tickets },
      where: { id: delivery.id },
    });
  }

  await query(strapi, PUSH_DELIVERY_UID).update({
    data: {
      lastError: null,
      processingStartedAt: null,
      sentAt: new Date().toISOString(),
      status: ticketErrors.length > 0 ? 'partial' : 'sent',
      ticketErrors,
      ticketIds: tickets,
    },
    where: { id: delivery.id },
  });

  strapi.log.info(
    `[push-delivery] Sent ${tickets.length} push notification(s) for ${delivery.notificationDocumentId}; ${ticketErrors.length} rejected`
  );
};

const markDeliveryForRetry = async (
  strapi: Core.Strapi,
  delivery: PushDelivery,
  error: unknown
) => {
  const attempts = (delivery.attempts ?? 0) + 1;
  const shouldRetry = attempts < MAX_ATTEMPTS;
  const retryDelay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  const message = error instanceof Error ? error.message : String(error);

  await query(strapi, PUSH_DELIVERY_UID).update({
    data: {
      attempts,
      lastError: message.slice(0, 2000),
      nextAttemptAt: shouldRetry
        ? new Date(Date.now() + retryDelay).toISOString()
        : null,
      processingStartedAt: null,
      status: shouldRetry ? 'pending' : 'failed',
    },
    where: { id: delivery.id },
  });

  strapi.log.error(
    `[push-delivery] Delivery ${delivery.id} failed on attempt ${attempts}: ${message}`
  );
};

const recoverStaleDeliveries = async (strapi: Core.Strapi) => {
  await query(strapi, PUSH_DELIVERY_UID).updateMany({
    data: {
      nextAttemptAt: new Date().toISOString(),
      processingStartedAt: null,
      status: 'pending',
    },
    where: {
      processingStartedAt: {
        $lt: new Date(Date.now() - STALE_PROCESSING_MS).toISOString(),
      },
      status: 'processing',
    },
  });
};

const enqueueActivePublishedNotifications = async (strapi: Core.Strapi) => {
  const now = new Date();
  const activeAfter = new Date(now.getTime() - NOTIFICATION_LIFETIME_MS).toISOString();
  const notifications = (await strapi.documents(APP_NOTIFICATION_UID as never).findMany({
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
    limit: 500,
  } as any)) as PublishedNotification[];

  for (const notification of notifications) {
    await enqueuePublishedNotification(strapi, notification);
  }
};

export const enqueuePublishedNotification = async (
  strapi: Core.Strapi,
  notification: PublishedNotification
) => {
  const documentId = notification.documentId?.trim();
  const title = notification.title?.trim();
  const pushMessage = notification.pushMessage?.trim();
  const activeAt = toIsoDate(notification.scheduledFor ?? notification.publishedAt);

  if (!documentId || !title || !pushMessage || !activeAt) {
    return false;
  }

  const deliveryKey = `${documentId}:${activeAt}`;
  const existing = await query(strapi, PUSH_DELIVERY_UID).findOne({
    select: ['id', 'status'],
    where: { deliveryKey },
  });

  if (existing) {
    if (existing.status === 'pending') {
      await query(strapi, PUSH_DELIVERY_UID).update({
        data: { pushMessage, title },
        where: { id: existing.id },
      });
    }

    return false;
  }

  try {
    await query(strapi, PUSH_DELIVERY_UID).create({
      data: {
        activeAt,
        attempts: 0,
        deliveryKey,
        nextAttemptAt: activeAt,
        notificationDocumentId: documentId,
        pushMessage,
        status: 'pending',
        title,
      },
    });
  } catch (error) {
    const duplicate = await query(strapi, PUSH_DELIVERY_UID).findOne({
      select: ['id'],
      where: { deliveryKey },
    });

    if (!duplicate) {
      throw error;
    }

    return false;
  }

  strapi.log.info(`[push-delivery] Queued ${deliveryKey}`);
  return true;
};

export const processPendingPushDeliveries = async (strapi: Core.Strapi) => {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  try {
    await enqueueActivePublishedNotifications(strapi);
    await recoverStaleDeliveries(strapi);

    const now = new Date().toISOString();
    const deliveries = (await query(strapi, PUSH_DELIVERY_UID).findMany({
      limit: DELIVERY_BATCH_SIZE,
      orderBy: [{ activeAt: 'asc' }, { id: 'asc' }],
      where: {
        activeAt: { $lte: now },
        nextAttemptAt: { $lte: now },
        status: 'pending',
      },
    })) as PushDelivery[];

    for (const delivery of deliveries) {
      if (new Date(delivery.activeAt).getTime() + NOTIFICATION_LIFETIME_MS <= Date.now()) {
        await query(strapi, PUSH_DELIVERY_UID).update({
          data: {
            lastError: 'The notification expired before push delivery completed',
            nextAttemptAt: null,
            processingStartedAt: null,
            status: 'expired',
          },
          where: { id: delivery.id },
        });
        continue;
      }

      const claimed = await query(strapi, PUSH_DELIVERY_UID).updateMany({
        data: {
          processingStartedAt: new Date().toISOString(),
          status: 'processing',
        },
        where: { id: delivery.id, status: 'pending' },
      });

      if (!claimed?.count) {
        continue;
      }

      try {
        await sendDelivery(strapi, delivery);
      } catch (error) {
        await markDeliveryForRetry(strapi, delivery, error);
      }
    }
  } finally {
    workerRunning = false;
  }
};

export const registerNotificationPublishHook = (strapi: Core.Strapi) => {
  strapi.documents.use(async (context: any, next: () => Promise<any>) => {
    const result = await next();

    if (
      context.uid !== APP_NOTIFICATION_UID ||
      !['create', 'publish', 'update'].includes(context.action)
    ) {
      return result;
    }

    const entries = Array.isArray(result?.entries)
      ? result.entries
      : result?.publishedAt
        ? [result]
        : [];

    for (const entry of entries) {
      try {
        await enqueuePublishedNotification(strapi, entry);
      } catch (error) {
        strapi.log.error(
          `[push-delivery] Could not queue ${entry?.documentId ?? 'notification'}: ${String(error)}`
        );
      }
    }

    if (entries.length > 0) {
      queueMicrotask(() => {
        void processPendingPushDeliveries(strapi).catch((error) => {
          strapi.log.error(`[push-delivery] Worker failed: ${String(error)}`);
        });
      });
    }

    return result;
  });
};
