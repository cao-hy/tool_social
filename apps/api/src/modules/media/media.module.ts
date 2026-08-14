import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MEDIA_SERVICE } from './media.tokens';

@Module({
  controllers: [MediaController],
  providers: [MediaService, { provide: MEDIA_SERVICE, useExisting: MediaService }],
  exports: [MediaService, MEDIA_SERVICE],
})
export class MediaModule {}
