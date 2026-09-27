import type { Core } from '@strapi/strapi';

const APP_NOTIFICATION_UID = 'api::app-notification.app-notification';
const PUSH_DELIVERY_UID = 'api::push-delivery.push-delivery';
const PUSH_SUBSCRIPTION_UID = 'api::push-subscription.push-subscription';

const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_BATCH_SIZE = 100;
const EXPO_RECEIPT_BATCH_SIZE = 1000;
const SUBSCRIPTION_PAGE_SIZE = 500;
const DELIVERY_BATCH_SIZE = 10;
const RECEIPT_DELIVERY_BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const NOTIFICATION_LIFETIME_SECONDS = 72 * 60 * 60;
const NOTIFICATION_LIFETIME_MS = NOTIFICATION_LIFETIME_SECONDS * 1000;
const RECEIPT_INITIAL_DELAY_MS = 15 * 60 * 1000;
const RECEIPT_RETRY_DELAY_MS = 15 * 60 * 1000;
const RECEIPT_MAX_AGE_MS = 23 * 60 * 60 * 1000;
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
  receiptAttempts?: number;
  receiptResults?: StoredReceipt[] | null;
  receiptStatus?: string;
  sentAt?: string | null;
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

type ExpoPushReceipt = {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
};

type ExpoReceiptResponse = {
  data?: Record<string, ExpoPushReceipt>;
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

type StoredReceipt = {
  error: string | null;
  id: string;
  message: string | null;
  status: 'ok' | 'error';
  token: string;
};

type ReceiptSummary = {
  checkedAt: string;
  failed: number;
  successful: number;
  ticketRejected: number;
  unavailable: number;
};

let workerRunning = false;
let receiptReconciliationLogged = false;

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

const buildReceiptSummary = (
  delivery: PushDelivery,
  receiptResults: StoredReceipt[],
  unavailable: number,
  checkedAt: string
): ReceiptSummary => ({
  checkedAt,
  failed: receiptResults.filter((receipt) => receipt.status === 'error').length,
  successful: receiptResults.filter((receipt) => receipt.status === 'ok').length,
  ticketRejected: Array.isArray(delivery.ticketErrors)
    ? delivery.ticketErrors.length
    : 0,
  unavailable,
});

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

const disableSubscriptionByToken = async (strapi: Core.Strapi, token: string) => {
  await query(strapi, PUSH_SUBSCRIPTION_UID).updateMany({
    data: { enabled: false },
    where: { enabled: true, token },
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
      data: {
        nextReceiptCheckAt:
          tickets.length > 0
            ? new Date(Date.now() + RECEIPT_INITIAL_DELAY_MS).toISOString()
            : null,
        receiptAttempts: 0,
        receiptLastError: null,
        receiptResults: [],
        receiptStatus: tickets.length > 0 ? 'pending' : 'not_required',
        ticketErrors,
        ticketIds: tickets,
      },
      where: { id: delivery.id },
    });
  }

  const sentAt = new Date().toISOString();
  const receiptSummary =
    tickets.length === 0
      ? buildReceiptSummary(
          { ...delivery, ticketErrors },
          [],
          0,
          sentAt
        )
      : null;
  await query(strapi, PUSH_DELIVERY_UID).update({
    data: {
      lastError: null,
      nextReceiptCheckAt:
        tickets.length > 0
          ? new Date(Date.now() + RECEIPT_INITIAL_DELAY_MS).toISOString()
          : null,
      processingStartedAt: null,
      receiptAttempts: 0,
      receiptLastError: null,
      receiptResults: [],
      receiptStatus: tickets.length > 0 ? 'pending' : 'not_required',
      receiptSummary,
      sentAt,
      status: ticketErrors.length > 0 ? 'partial' : 'sent',
      ticketErrors: tickets.length > 0 ? ticketErrors : [],
      ticketIds: tickets,
    },
    where: { id: delivery.id },
  });

  strapi.log.info(
    `[push-delivery] Sent ${tickets.length} push notification(s) for ${delivery.notificationDocumentId}; ${ticketErrors.length} rejected`
  );
};

const markReceiptCheckForRetry = async (
  strapi: Core.Strapi,
  delivery: PushDelivery,
  error: unknown
) => {
  const attempts = (delivery.receiptAttempts ?? 0) + 1;
  const sentAt = new Date(delivery.sentAt ?? '').getTime();
  const deadlinePassed =
    !Number.isFinite(sentAt) || sentAt + RECEIPT_MAX_AGE_MS <= Date.now();
  const message = error instanceof Error ? error.message : String(error);
  const receiptResults = Array.isArray(delivery.receiptResults)
    ? delivery.receiptResults
    : [];
  const tickets = Array.isArray(delivery.ticketIds) ? delivery.ticketIds : [];
  const completedIds = new Set(receiptResults.map((receipt) => receipt.id));
  const unavailable = tickets.filter((ticket) => !completedIds.has(ticket.id)).length;
  const checkedAt = new Date().toISOString();

  await query(strapi, PUSH_DELIVERY_UID).update({
    data: {
      nextReceiptCheckAt: deadlinePassed
        ? null
        : new Date(Date.now() + RECEIPT_RETRY_DELAY_MS).toISOString(),
      receiptAttempts: attempts,
      receiptLastError: message.slice(0, 2000),
      receiptProcessingStartedAt: null,
      receiptResults: deadlinePassed ? [] : receiptResults,
      receiptStatus: deadlinePassed
        ? receiptResults.length > 0
          ? 'partial'
          : 'failed'
        : 'pending',
      receiptSummary: deadlinePassed
        ? buildReceiptSummary(delivery, receiptResults, unavailable, checkedAt)
        : null,
      ticketErrors: deadlinePassed ? [] : delivery.ticketErrors,
      ticketIds: deadlinePassed ? [] : tickets,
      ...(deadlinePassed ? { receiptCheckedAt: checkedAt } : {}),
    },
    where: { id: delivery.id },
  });

  strapi.log.error(
    `[push-delivery] Receipt check for delivery ${delivery.id} failed on attempt ${attempts}: ${message}`
  );
};

const checkDeliveryReceipts = async (
  strapi: Core.Strapi,
  delivery: PushDelivery
) => {
  const tickets = Array.isArray(delivery.ticketIds) ? delivery.ticketIds : [];
  const receiptResults: StoredReceipt[] = Array.isArray(delivery.receiptResults)
    ? [...delivery.receiptResults]
    : [];
  const completedIds = new Set(receiptResults.map((receipt) => receipt.id));
  const pendingTickets = tickets.filter((ticket) => !completedIds.has(ticket.id));

  for (const ticketBatch of chunk(pendingTickets, EXPO_RECEIPT_BATCH_SIZE)) {
    const response = await fetch(EXPO_RECEIPTS_URL, {
      body: JSON.stringify({ ids: ticketBatch.map((ticket) => ticket.id) }),
      headers: getExpoHeaders(),
      method: 'POST',
    });
    const payload = (await response.json().catch(() => ({}))) as ExpoReceiptResponse;

    if (!response.ok) {
      const details = payload.errors?.map((error) => error.message).filter(Boolean).join('; ');
      throw new Error(
        `Expo receipt request failed (${response.status})${details ? `: ${details}` : ''}`
      );
    }

    for (const ticket of ticketBatch) {
      const receipt = payload.data?.[ticket.id];

      if (!receipt) {
        continue;
      }

      const error = receipt.details?.error ?? null;
      receiptResults.push({
        error,
        id: ticket.id,
        message: receipt.message ?? null,
        status: receipt.status,
        token: ticket.token,
      });
      completedIds.add(ticket.id);

      if (error === 'DeviceNotRegistered') {
        await disableSubscriptionByToken(strapi, ticket.token);
      }
    }

    await query(strapi, PUSH_DELIVERY_UID).update({
      data: { receiptResults },
      where: { id: delivery.id },
    });
  }

  const checkedAt = new Date().toISOString();
  const unresolvedCount = tickets.filter((ticket) => !completedIds.has(ticket.id)).length;
  const hasErrors =
    receiptResults.some((receipt) => receipt.status === 'error') ||
    Boolean(delivery.ticketErrors?.length);
  const sentAt = new Date(delivery.sentAt ?? '').getTime();
  const deadlinePassed =
    !Number.isFinite(sentAt) || sentAt + RECEIPT_MAX_AGE_MS <= Date.now();
  const receiptStatus =
    unresolvedCount === 0
      ? hasErrors
        ? 'partial'
        : 'complete'
      : deadlinePassed
        ? receiptResults.length > 0
          ? 'partial'
          : 'failed'
        : 'pending';
  const receiptLastError =
    unresolvedCount > 0 && deadlinePassed
      ? `${unresolvedCount} Expo push receipt(s) were unavailable before the receipt deadline`
      : null;
  const isTerminal = receiptStatus !== 'pending';
  const receiptSummary = isTerminal
    ? buildReceiptSummary(delivery, receiptResults, unresolvedCount, checkedAt)
    : null;

  await query(strapi, PUSH_DELIVERY_UID).update({
    data: {
      nextReceiptCheckAt:
        receiptStatus === 'pending'
          ? new Date(Date.now() + RECEIPT_RETRY_DELAY_MS).toISOString()
          : null,
      receiptAttempts: (delivery.receiptAttempts ?? 0) + 1,
      receiptCheckedAt: checkedAt,
      receiptLastError,
      receiptProcessingStartedAt: null,
      receiptResults: isTerminal ? [] : receiptResults,
      receiptStatus,
      receiptSummary,
      ticketErrors: isTerminal ? [] : delivery.ticketErrors,
      ticketIds: isTerminal ? [] : tickets,
    },
    where: { id: delivery.id },
  });

  strapi.log.info(
    `[push-delivery] Receipt check for ${delivery.notificationDocumentId}: ${receiptResults.length} resolved, ${unresolvedCount} pending`
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

const recoverStaleReceiptChecks = async (strapi: Core.Strapi) => {
  await query(strapi, PUSH_DELIVERY_UID).updateMany({
    data: {
      nextReceiptCheckAt: new Date().toISOString(),
      receiptProcessingStartedAt: null,
      receiptStatus: 'pending',
    },
    where: {
      receiptProcessingStartedAt: {
        $lt: new Date(Date.now() - STALE_PROCESSING_MS).toISOString(),
      },
      receiptStatus: 'checking',
    },
  });
};

const initializeReceiptPollingForRecentDeliveries = async (
  strapi: Core.Strapi
) => {
  const recentDeliveries = (await query(strapi, PUSH_DELIVERY_UID).findMany({
    limit: 500,
    orderBy: { sentAt: 'desc' },
    where: {
      sentAt: {
        $gt: new Date(Date.now() - RECEIPT_MAX_AGE_MS).toISOString(),
      },
      status: { $in: ['sent', 'partial'] },
    },
  })) as PushDelivery[];
  const candidates = recentDeliveries.filter(
    (delivery) =>
      !delivery.receiptStatus || delivery.receiptStatus === 'not_required'
  );
  let scheduledCount = 0;

  for (const delivery of candidates) {
    if (!Array.isArray(delivery.ticketIds) || delivery.ticketIds.length === 0) {
      continue;
    }

    const sentAt = new Date(delivery.sentAt ?? '').getTime();
    const firstCheckAt = Number.isFinite(sentAt)
      ? Math.max(Date.now(), sentAt + RECEIPT_INITIAL_DELAY_MS)
      : Date.now();

    await query(strapi, PUSH_DELIVERY_UID).update({
      data: {
        nextReceiptCheckAt: new Date(firstCheckAt).toISOString(),
        receiptAttempts: 0,
        receiptResults: [],
        receiptStatus: 'pending',
      },
      where: { id: delivery.id },
    });
    scheduledCount += 1;
  }

  if (!receiptReconciliationLogged) {
    const states = Object.entries(
      recentDeliveries.reduce<Record<string, number>>((counts, delivery) => {
        const status = delivery.receiptStatus || 'legacy';
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      }, {})
    )
      .map(([status, count]) => `${status}:${count}`)
      .join(', ');

    strapi.log.info(
      `[push-delivery] Receipt reconciliation inspected ${recentDeliveries.length} recent delivery record(s); scheduled ${scheduledCount}; states ${states || 'none'}`
    );
    receiptReconciliationLogged = true;
  }
};

const processPendingPushReceipts = async (strapi: Core.Strapi) => {
  await recoverStaleReceiptChecks(strapi);
  await initializeReceiptPollingForRecentDeliveries(strapi);

  const now = new Date().toISOString();
  const deliveries = (await query(strapi, PUSH_DELIVERY_UID).findMany({
    limit: RECEIPT_DELIVERY_BATCH_SIZE,
    orderBy: [{ nextReceiptCheckAt: 'asc' }, { id: 'asc' }],
    where: {
      nextReceiptCheckAt: { $lte: now },
      receiptStatus: 'pending',
    },
  })) as PushDelivery[];

  for (const delivery of deliveries) {
    const claimed = await query(strapi, PUSH_DELIVERY_UID).updateMany({
      data: {
        receiptProcessingStartedAt: new Date().toISOString(),
        receiptStatus: 'checking',
      },
      where: { id: delivery.id, receiptStatus: 'pending' },
    });

    if (!claimed?.count) {
      continue;
    }

    try {
      await checkDeliveryReceipts(strapi, delivery);
    } catch (error) {
      await markReceiptCheckForRetry(strapi, delivery, error);
    }
  }
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

    await processPendingPushReceipts(strapi);
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
