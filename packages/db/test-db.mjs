import { PrismaClient } from './generated/client/index.js';

const prisma = new PrismaClient();

async function main() {
  const media = await prisma.mediaAsset.findMany({
    include: {
      platformPosts: { select: { platformPost: { select: { status: true } } } },
      posts: { select: { contentPost: { select: { status: true } } } },
    }
  });
  
  console.log(JSON.stringify(media, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
