import BatchView from '@/components/evidence/BatchView'

export const metadata = { title: 'Batch of claims' }

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <BatchView id={id} />
}
