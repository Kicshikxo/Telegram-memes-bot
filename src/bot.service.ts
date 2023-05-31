import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Markup, Scenes, Telegraf, session } from 'telegraf'
import { MemeStatus, Role } from './prisma/client'
import { PrismaService } from './prisma/prisma.service'

enum Scene {
    MENU = 'MENU',
    INIT = 'INIT',
    CHANGE_USERNAME = 'CHANGE_USERNAME',
    UPLOAD_MEMES = 'UPLOAD_MEMES',
    VIEW_MEMES = 'VIEW_MEMES',
    POST_MEMES = 'POST_MEMES'
}

enum Action {
    CHANGE_USERNAME = 'Изменить имя пользователя',
    UPLOAD_MEMES = 'Отправить мемы',

    VIEW_MEMES = 'Посмотреть мемы',
    POST_MEMES = 'Опубликовать мемы',

    APPROVE_MEME = 'Одобрить мем',
    SKIP_MEME = 'Пропустить мем',
    REJECT_MEME = 'Отклонить мем',

    SKIP = 'Пропустить',

    UPDATE_MENU = 'Обновить',
    EXIT_TO_MENU = 'Выйти в меню'
}

enum PostMemesAction {
    CONFIRM_POST = 'Опубликовать',
    CANCEL_POST = 'Не публиковать',

    DISAPPROVE_MEMES = 'Очистить список одобренных мемов',
    CONFIRM_DISAPPROVE = 'Очистить',
    CANCEL_DISAPPROVE = 'Не очищать'
}

enum MemeViewType {
    RANDOM = 'Случайные',
    NEWEST = 'Самые последние',
    OLDEST = 'Самые старые'
}

interface SceneState {
    memeViewType: MemeViewType
    viewedMemeId: string
    skippedMemesId: string[]
}

@Injectable()
export class BotService {
    constructor(private readonly prismaService: PrismaService, private readonly configService: ConfigService) {}

    private bot: Telegraf<Scenes.SceneContext>

    private menuScene = new Scenes.BaseScene<Scenes.SceneContext>(Scene.MENU)
    private initScene = new Scenes.BaseScene<Scenes.SceneContext>(Scene.INIT)
    private changeUsernameScene = new Scenes.BaseScene<Scenes.SceneContext>(Scene.CHANGE_USERNAME)
    private uploadMemesScene = new Scenes.BaseScene<Scenes.SceneContext>(Scene.UPLOAD_MEMES)
    private viewMemesScene = new Scenes.BaseScene<Scenes.SceneContext>(Scene.VIEW_MEMES)
    private postMemesScene = new Scenes.BaseScene<Scenes.SceneContext>(Scene.POST_MEMES)

    async onModuleInit() {
        await this.initBot()
        await this.initScenes()
        await this.startBot()
    }

    async initBot() {
        const token = this.configService.get('MEMES_BOT_TOKEN')
        if (!token) throw new ReferenceError('MEMES_BOT_TOKEN environment variable is not provided')

        this.bot = new Telegraf(token)

        const stage = new Scenes.Stage<Scenes.SceneContext>([
            this.menuScene,
            this.initScene,
            this.changeUsernameScene,
            this.uploadMemesScene,
            this.viewMemesScene,
            this.postMemesScene
        ])

        this.bot.use(session())
        this.bot.use(stage.middleware())
        this.bot.use(async (ctx, next) => {
            if (!ctx.scene.current) {
                if (!ctx.from) return

                await this.prismaService.user.upsert({
                    where: { id: ctx.from.id.toString() },
                    create: { id: ctx.from.id.toString() },
                    update: {}
                })
                await ctx.scene.enter(Scene.MENU)
            }

            next()
        })

        this.bot.command('menu', (ctx) => {
            if (ctx.scene.current?.id !== Scene.MENU) {
                ctx.scene.enter(Scene.MENU)
            }
        })

        this.bot.telegram.setMyCommands([
            {
                command: 'menu',
                description: 'Выйти в меню'
            }
        ])
    }

    async initScenes() {
        // Menu Scene
        const getUserInfo = async (ctx: Scenes.SceneContext) => {
            if (!ctx.from) return

            const user = await this.prismaService.user.findUnique({
                where: { id: ctx.from.id.toString() }
            })

            if (!user?.username) {
                return
            }

            const memes = await this.prismaService.meme.groupBy({
                by: ['status'],
                _count: {
                    _all: true
                }
            })

            const userMemes = await this.prismaService.meme.groupBy({
                where: { userId: ctx.from.id.toString() },
                by: ['status'],
                _count: {
                    _all: true
                }
            })

            return (
                `Ваше имя пользователя: *${user.username}*\n` +
                `Ваша роль: *${user.role === Role.MEME_UPLOADER ? 'Кидатель мемов' : 'Просмотрщик мемов'}*\n\n` +
                `Мемов загружено вами: *${userMemes.reduce((acc, value) => (acc += value?._count._all), 0)}*\n\n` +
                (user.role === Role.MEME_MANAGER
                    ? `Мемов загружено всего: *${memes.reduce(
                          (acc, value) => (acc += value?._count._all),
                          0
                      )}*\nМемов не просмотренно: *${
                          memes.find(({ status }) => status === MemeStatus.UPLOADED)?._count._all ?? 0
                      }*\nМемов одобрено: *${
                          memes.find(({ status }) => status === MemeStatus.APPROVED)?._count._all ?? 0
                      }*\nМемов отклонено: *${
                          memes.find(({ status }) => status === MemeStatus.REJECTED)?._count._all ?? 0
                      }*\nМемов опубликовано: *${memes.find(({ status }) => status === MemeStatus.POSTED)?._count._all ?? 0}*`
                    : `Мемов отклонено: ${
                          userMemes.find(({ status }) => status === MemeStatus.REJECTED)?._count._all ?? 0
                      }\nМемов одобрено/опубликованно: ${
                          (userMemes.find(({ status }) => status === MemeStatus.APPROVED)?._count._all ?? 0) +
                          (userMemes.find(({ status }) => status === MemeStatus.POSTED)?._count._all ?? 0)
                      }`) +
                `\n\nДата присоединения: *${user.createdAt.toLocaleString('ru')}*`
            )
        }
        this.menuScene.enter(async (ctx) => {
            if (!ctx.from) return

            const user = await this.prismaService.user.findUnique({
                where: { id: ctx.from.id.toString() }
            })
            if (!user?.username) {
                await ctx.scene.enter(Scene.INIT)
                return
            }

            const userInfo = await getUserInfo(ctx)
            if (!userInfo) {
                await ctx.scene.enter(Scene.INIT)
                return
            }

            await ctx.reply(userInfo, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[{ text: Action.UPDATE_MENU, callback_data: Action.UPDATE_MENU }]])
            })
            await ctx.reply(
                'Для действий используйте кнопки ниже',
                Markup.keyboard([
                    [Action.CHANGE_USERNAME, Action.UPLOAD_MEMES],
                    [
                        ...(user?.role === Role.MEME_MANAGER ? [Action.VIEW_MEMES] : []),
                        ...(user?.role === Role.MEME_MANAGER ? [Action.POST_MEMES] : [])
                    ]
                ]).resize()
            )
        })
        //
        this.menuScene.action(Action.UPDATE_MENU, async (ctx) => {
            const userInfo = await getUserInfo(ctx)
            if (!userInfo) {
                return
            }

            try {
                await ctx.editMessageText(userInfo, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[{ text: Action.UPDATE_MENU, callback_data: Action.UPDATE_MENU }]])
                })
            } catch (e) {}

            await ctx.answerCbQuery()
        })
        //
        this.menuScene.hears(Action.CHANGE_USERNAME, async (ctx) => {
            await ctx.scene.enter(Scene.CHANGE_USERNAME)
        })
        this.menuScene.hears(Action.UPLOAD_MEMES, async (ctx) => {
            await ctx.scene.enter(Scene.UPLOAD_MEMES)
        })
        this.menuScene.hears(Action.VIEW_MEMES, async (ctx) => {
            await ctx.scene.enter(Scene.VIEW_MEMES)
        })
        this.menuScene.hears(Action.POST_MEMES, async (ctx) => {
            await ctx.scene.enter(Scene.POST_MEMES)
        })

        // Init Scene

        this.initScene.enter(async (ctx) => {
            await ctx.reply('Привет, для начала давай познакомимся!')
            await ctx.scene.enter(Scene.CHANGE_USERNAME)
        })

        // Change username Scene

        this.changeUsernameScene.enter(async (ctx) => {
            if (!ctx.from) return

            const user = await this.prismaService.user.findUnique({
                where: { id: ctx.from.id.toString() }
            })

            await ctx.reply('Введите имя пользователя', user?.username ? Markup.keyboard([[Action.SKIP]]).resize() : {})
        })
        //
        this.changeUsernameScene.hears(Action.SKIP, async (ctx) => {
            await ctx.scene.enter(Scene.MENU)
        })
        this.changeUsernameScene.on('text', async (ctx) => {
            if (await this.prismaService.user.findUnique({ where: { username: ctx.message.text } })) {
                ctx.reply('Имя пользователя уже используется, попробуйте другое')
                return
            }

            const user = await this.prismaService.user.findUnique({
                where: { id: ctx.from.id.toString() }
            })

            await this.prismaService.user.update({
                where: { id: ctx.from.id.toString() },
                data: { username: ctx.message.text }
            })

            if (!user?.username) {
                await ctx.reply('Вы можете в любой момент изменить имя пользователя в меню')
                await ctx.reply('Теперь вы можете отправлять мемы')
            } else {
                await ctx.reply('Ваше имя пользователя успешно изменено')
            }
            await ctx.scene.enter(Scene.MENU)
        })

        // Send memes Scene

        this.uploadMemesScene.enter(async (ctx) => {
            await ctx.reply(
                'Для загрузки мема отправьте мне его в виде изображения',
                Markup.keyboard([[Action.EXIT_TO_MENU]]).resize()
            )
        })
        //
        this.uploadMemesScene.on('photo', async (ctx) => {
            if (!ctx.from) return

            const fileId = ctx.message.photo.at(-1)?.file_id
            if (!fileId) return

            const { href: link } = await this.bot.telegram.getFileLink(fileId)
            await this.prismaService.meme.create({
                data: {
                    userId: ctx.from.id.toString(),
                    link: link,
                    status: MemeStatus.UPLOADED
                }
            })
            await ctx.reply('Мем успешно загружен')
            await ctx.reply('Можете загрузить ещё или выйти в меню', Markup.keyboard([[Action.EXIT_TO_MENU]]).resize())
        })
        this.uploadMemesScene.hears(Action.EXIT_TO_MENU, async (ctx) => {
            await ctx.scene.enter(Scene.MENU)
        })

        // View meme Scene

        this.viewMemesScene.enter(async (ctx) => {
            if (!ctx.from) return

            const user = await this.prismaService.user.findUnique({ where: { id: ctx.from.id.toString() } })

            if (user?.role !== Role.MEME_MANAGER) {
                await ctx.scene.enter(Scene.MENU)
                return
            }

            const state = ctx.scene.state as SceneState
            state.skippedMemesId = []

            await ctx.reply(
                'Выберите какие мемы вы хотите смотреть',
                Markup.keyboard([
                    [MemeViewType.RANDOM, MemeViewType.NEWEST, MemeViewType.OLDEST],
                    [Action.EXIT_TO_MENU]
                ]).resize()
            )
        })
        //
        const viewMeme = async (ctx: Scenes.SceneContext) => {
            const state = ctx.scene.state as SceneState

            const memes = await this.prismaService.meme.findMany({
                where: { id: { notIn: state.skippedMemesId }, status: MemeStatus.UPLOADED },
                include: { user: true },
                orderBy: { createdAt: 'desc' },
                take: state.memeViewType === MemeViewType.RANDOM ? undefined : 1
            })

            const meme = memes[Math.floor(Math.random() * memes.length)]

            if (!meme) {
                await ctx.reply('Мемы кончились', Markup.keyboard([[Action.EXIT_TO_MENU]]).resize())
                return
            }

            state.viewedMemeId = meme.id

            await ctx.replyWithPhoto(
                { url: meme.link },
                {
                    caption: `Прислал: <b>${
                        meme.user?.username ?? '<s>Удалённый аккаунт</s>'
                    }</b>\n\nЗагружен: <b>${meme.createdAt.toLocaleString('ru')}</b>`,
                    parse_mode: 'HTML',
                    ...Markup.keyboard([
                        [Action.APPROVE_MEME, Action.SKIP_MEME, Action.REJECT_MEME],
                        [Action.EXIT_TO_MENU]
                    ]).resize()
                }
            )
        }
        //
        this.viewMemesScene.hears(MemeViewType.RANDOM, async (ctx) => {
            const state = ctx.scene.state as SceneState
            state.memeViewType = MemeViewType.RANDOM
            await viewMeme(ctx)
        })
        this.viewMemesScene.hears(MemeViewType.NEWEST, async (ctx) => {
            const state = ctx.scene.state as SceneState
            state.memeViewType = MemeViewType.NEWEST
            await viewMeme(ctx)
        })
        this.viewMemesScene.hears(MemeViewType.OLDEST, async (ctx) => {
            const state = ctx.scene.state as SceneState
            state.memeViewType = MemeViewType.OLDEST
            await viewMeme(ctx)
        })
        //
        this.viewMemesScene.hears(Action.APPROVE_MEME, async (ctx) => {
            const state = ctx.scene.state as SceneState
            await this.prismaService.meme.update({
                where: { id: state.viewedMemeId },
                data: { status: MemeStatus.APPROVED }
            })
            await viewMeme(ctx)
        })
        this.viewMemesScene.hears(Action.SKIP_MEME, async (ctx) => {
            const state = ctx.scene.state as SceneState
            state.skippedMemesId = [...(state.skippedMemesId ?? []), state.viewedMemeId]
            await viewMeme(ctx)
        })
        this.viewMemesScene.hears(Action.REJECT_MEME, async (ctx) => {
            const state = ctx.scene.state as SceneState
            await this.prismaService.meme.update({
                where: { id: state.viewedMemeId },
                data: { status: MemeStatus.REJECTED }
            })
            await viewMeme(ctx)
        })
        //
        this.viewMemesScene.hears(Action.EXIT_TO_MENU, async (ctx) => {
            await ctx.scene.enter(Scene.MENU)
        })

        // Post memes Scene

        this.postMemesScene.enter(async (ctx) => {
            if (!ctx.from) return

            const user = await this.prismaService.user.findUnique({ where: { id: ctx.from.id.toString() } })

            if (user?.role !== Role.MEME_MANAGER) {
                await ctx.scene.enter(Scene.MENU)
                return
            }

            const memes = await this.prismaService.meme.findMany({
                where: { status: MemeStatus.APPROVED },
                include: { user: true }
            })

            if (!memes.length) {
                await ctx.reply('Нет одобренных мемов', Markup.keyboard([[Action.EXIT_TO_MENU]]).resize())
                return
            }

            await ctx.reply(
                'Предпросмотр поста(ов):',
                Markup.keyboard([[Action.POST_MEMES, PostMemesAction.DISAPPROVE_MEMES], [Action.EXIT_TO_MENU]]).resize()
            )
            for (let part = 0; part < Math.ceil(memes.length / 10); part++) {
                const memesPart = memes.slice(part * 10, 10 + part * 10)
                await ctx.replyWithMediaGroup(
                    memesPart.map((meme) => ({
                        type: 'photo',
                        media: { url: meme.link },
                        caption: `Мем от: ${meme.user?.username ?? '<s>Удалённый аккаунт</s>'}`,
                        parse_mode: 'HTML'
                    }))
                )
            }
        })
        this.postMemesScene.hears(Action.POST_MEMES, async (ctx) => {
            await ctx.reply('Вы действительно хотите опубливать мемы?\n<b><u>Это действие нельзя будет отменить</u></b>', {
                parse_mode: 'HTML',
                ...Markup.keyboard([[PostMemesAction.CONFIRM_POST, PostMemesAction.CANCEL_POST]]).resize()
            })
        })
        this.postMemesScene.hears(PostMemesAction.CONFIRM_POST, async (ctx) => {
            const memes = await this.prismaService.meme.findMany({
                where: { status: MemeStatus.APPROVED },
                include: { user: true }
            })

            try {
                const channelId = this.configService.get('MEMES_BOT_CHANNEL_ID')
                if (!channelId) throw new ReferenceError('MEMES_BOT_CHANNEL_ID environment variable is not provided')

                for (let part = 0; part < Math.ceil(memes.length / 10); part++) {
                    const memesPart = memes.slice(part * 10, 10 + part * 10)
                    await ctx.telegram.sendMediaGroup(
                        channelId,
                        memesPart.map((meme) => ({
                            type: 'photo',
                            media: { url: meme.link },
                            caption: `Мем от: ${meme.user?.username ?? '<s>Удалённый аккаунт</s>'}`,
                            parse_mode: 'HTML'
                        }))
                    )
                }
            } catch (e) {
                console.error(e)
                await ctx.reply('Ошибка публикации мемов')
                await ctx.scene.enter(Scene.MENU)
                return
            }

            await this.prismaService.meme.updateMany({
                where: { id: { in: memes.map((meme) => meme.id) } },
                data: { status: MemeStatus.POSTED }
            })

            await ctx.reply('Мемы опубликованы')
            await ctx.scene.enter(Scene.MENU)
        })
        this.postMemesScene.hears(PostMemesAction.CANCEL_POST, async (ctx) => {
            await ctx.scene.enter(Scene.POST_MEMES)
        })
        this.postMemesScene.hears(PostMemesAction.DISAPPROVE_MEMES, async (ctx) => {
            await ctx.reply(
                'Вы действительно хотите очистить список одобренных мемов?\n<b><u>Они попадут в список непросмотренных мемов</u></b>',
                {
                    parse_mode: 'HTML',
                    ...Markup.keyboard([[PostMemesAction.CONFIRM_DISAPPROVE, PostMemesAction.CANCEL_DISAPPROVE]]).resize()
                }
            )
        })
        this.postMemesScene.hears(PostMemesAction.CONFIRM_DISAPPROVE, async (ctx) => {
            await this.prismaService.meme.updateMany({
                where: { status: MemeStatus.APPROVED },
                data: { status: MemeStatus.UPLOADED }
            })
            await ctx.reply('Список одобренных мемов очищен')
            await ctx.scene.enter(Scene.MENU)
        })
        this.postMemesScene.hears(PostMemesAction.CANCEL_DISAPPROVE, async (ctx) => {
            await ctx.scene.enter(Scene.POST_MEMES)
        })
        this.postMemesScene.hears(Action.EXIT_TO_MENU, async (ctx) => {
            await ctx.scene.enter(Scene.MENU)
        })
    }

    async startBot() {
        this.bot.launch()
    }
}
