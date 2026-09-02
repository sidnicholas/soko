import { Injectable, NotFoundException } from "@nestjs/common";
import { getEntity, listEntityMembers, entityPriceStats, listComparableSupply, listEdgesFrom } from "@opportunity-os/db";

@Injectable()
export class EntityService {
  /** §market-graph intelligence surface: canonical item + members + price stats + comparables. */
  async intelligence(id: string) {
    const entity = await getEntity(id);
    if (!entity) throw new NotFoundException(`Entity ${id} not found`);
    const [members, priceStats, comparables, edges] = await Promise.all([
      listEntityMembers(id),
      entityPriceStats(id),
      listComparableSupply(id),
      listEdgesFrom("entity", id),
    ]);
    return { ...entity, members, price_stats: priceStats, comparables, graph_edges: edges };
  }
}
