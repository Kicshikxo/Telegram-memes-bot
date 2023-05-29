import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { BotModule } from './bot.module'

async function bootstrap() {
    const app = await NestFactory.create(BotModule)
    const configService = app.get(ConfigService)
    await app.listen(configService.get('PORT') ?? 3000)
}
bootstrap()
