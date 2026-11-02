import { Module } from '@nestjs/common';
import { DiscoveryController } from './discovery.controller.js';

@Module({ controllers: [DiscoveryController] })
export class DiscoveryModule {}
