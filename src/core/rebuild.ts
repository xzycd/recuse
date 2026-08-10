/**
 * Cumulative positions, rebuilt by adding up fills. Pure.
 *
 * The subgraph served these as stored fields, `quantityBought` and `netValue`,
 * and this arrives at the same numbers from the trade log instead. The
 * definitions are copied from that schema deliberately, so a position rebuilt
 * here and a position read there mean the same thing and can sit in the same
 * table:
 *
 *   bought    every buy, in tokens. Selling later does not reduce it.
 *   sold      every sell, in tokens.
 *   net       bought minus sold, which for a settled market is the position
 *             held when trading stopped, and so what was paid out on.
 *   spent     dollars paid across the buys.
 *   netSpent  spent minus dollars received back, the cost basis of `net`.
 *
 * Checked against the subgraph on a market it had indexed: same wallets, same
 * order, within 0.2% on every row of the top six.
 *
 * Rounded to six decimals at the end because USDC has six and a float sum of
 * ten thousand fills otherwise leaves a wallet that bought and sold the same
 * amount holding 4e-10 tokens, which prints as a position.
 */

/** The part of a trade this arithmetic needs, and nothing else. */
export interface TradeLike {
  address: string;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
}

export interface RebuiltPosition {
  address: string;
  bought: number;
  sold: number;
  net: number;
  spent: number;
  netSpent: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

interface Running {
  address: string;
  bought: number;
  sold: number;
  spent: number;
  received: number;
}

function add(running: Running, trade: TradeLike): void {
  if (trade.side === 'BUY') {
    running.bought += trade.size;
    running.spent += trade.size * trade.price;
  } else {
    running.sold += trade.size;
    running.received += trade.size * trade.price;
  }
}

function settle(running: Running): RebuiltPosition {
  return {
    address: running.address,
    bought: round6(running.bought),
    sold: round6(running.sold),
    net: round6(running.bought - running.sold),
    spent: round6(running.spent),
    netSpent: round6(running.spent - running.received),
  };
}

/**
 * Who bought one outcome token, largest buyer first.
 *
 * Selected on the token id rather than on the outcome text. The text is a label
 * chosen by whoever wrote the market and two markets in a scan can both call a
 * side "Yes"; the id is what the payout is settled against. A wallet that only
 * ever sold this token is dropped, because it never held a position to be paid
 * on and listing it among the buyers would be a claim about a purchase that
 * never happened.
 */
export function positionsForToken(trades: TradeLike[], tokenId: string): RebuiltPosition[] {
  const by = new Map<string, Running>();

  for (const trade of trades) {
    if (trade.tokenId !== tokenId) continue;
    let running = by.get(trade.address);
    if (!running) {
      running = { address: trade.address, bought: 0, sold: 0, spent: 0, received: 0 };
      by.set(trade.address, running);
    }
    add(running, trade);
  }

  return [...by.values()]
    .filter((r) => r.bought > 0)
    .map(settle)
    .sort((a, b) => b.bought - a.bought);
}

export interface RebuiltWalletPosition extends RebuiltPosition {
  tokenId: string;
  conditionId: string;
}

/**
 * One wallet's positions, one per outcome token, largest surviving first.
 *
 * Ordered on `net` rather than on `bought` because this feeds a ledger, where
 * what matters is what was still held when the market settled. A token bought
 * and sold in full is kept: it nets to zero, it earns nothing, and it is still
 * part of the record.
 */
export function positionsForWallet(trades: TradeLike[]): RebuiltWalletPosition[] {
  const by = new Map<string, Running & { conditionId: string }>();

  for (const trade of trades) {
    let running = by.get(trade.tokenId);
    if (!running) {
      running = {
        address: trade.address,
        conditionId: trade.conditionId,
        bought: 0, sold: 0, spent: 0, received: 0,
      };
      by.set(trade.tokenId, running);
    }
    add(running, trade);
  }

  return [...by.entries()]
    .map(([tokenId, running]) => ({
      tokenId, conditionId: running.conditionId, ...settle(running),
    }))
    .sort((a, b) => b.net - a.net);
}
