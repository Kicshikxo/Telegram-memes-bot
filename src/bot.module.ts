import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { BotService } from './bot.service'
import { PrismaService } from './prisma/prisma.service'

@Module({
    imports: [ConfigModule.forRoot()],
    controllers: [],
    providers: [BotService, PrismaService]
})
export class BotModule {}
