import { BLOCK_TYPE } from '../block-node'
import StatusBlock from './StatusBlock.astro'

/** The site-side renderers EmDash merges into `<PortableText>`. The export name is required. */
export const blockComponents = {
  [BLOCK_TYPE]: StatusBlock,
}
