import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { ListNotificationsQuery } from './notifications.schemas';

@Injectable()
export class NotificationsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(workspaceId: string, userId: string, query: ListNotificationsQuery) {
    const items = await this.prisma.notification.findMany({
      where: {
        workspaceId,
        userId,
        readAt: query.unreadOnly ? null : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });

    return { items: items.map((item) => this.toView(item)) };
  }

  async markRead(workspaceId: string, userId: string, notificationId: string) {
    const notification = await this.prisma.notification.updateMany({
      where: { id: notificationId, workspaceId, userId, readAt: null },
      data: { readAt: new Date() },
    });

    return { updated: notification.count };
  }

  async markAllRead(workspaceId: string, userId: string) {
    const notification = await this.prisma.notification.updateMany({
      where: { workspaceId, userId, readAt: null },
      data: { readAt: new Date() },
    });

    return { updated: notification.count };
  }

  private toView(notification: {
    id: string;
    type: string;
    title: string;
    body: string | null;
    linkUrl: string | null;
    data: unknown;
    readAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      linkUrl: notification.linkUrl,
      data: notification.data,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    };
  }
}
