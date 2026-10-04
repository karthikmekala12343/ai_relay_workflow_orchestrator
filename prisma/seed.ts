import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const workflow = await prisma.workflow.upsert({
    where: { id: 'wf-demo' },
    update: {},
    create: {
      id: 'wf-demo',
      name: 'Demo approval workflow',
      description: 'A seeded workflow for local verification.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      maxSteps: 10,
      nodes: [
        {
          id: 'node-start',
          type: 'notify',
          label: 'Start notification',
          args: { message: 'Workflow started' },
          nextNodeId: 'node-approval',
        },
        {
          id: 'node-approval',
          type: 'approval',
          label: 'Approval gate',
          args: { message: 'Approve the workflow run' },
          nextNodeId: 'node-finish',
        },
        {
          id: 'node-finish',
          type: 'notify',
          label: 'Final notification',
          args: { message: 'Workflow approved' },
        },
      ],
    },
  });

  console.log(`Seeded workflow: ${workflow.id} (${workflow.name})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
