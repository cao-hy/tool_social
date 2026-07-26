import { Module } from '@nestjs/common';
import { PlatformsController } from './platforms.controller';

@Module({
  controllers: [PlatformsController],
})
export class PlatformsModule {}
