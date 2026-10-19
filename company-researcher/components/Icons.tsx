"use client";
// One icon per section, from Phosphor (one icon family for the whole app, duotone weight).
import {
  BriefcaseIcon, BuildingsIcon, ChartLineUpIcon, CurrencyCircleDollarIcon, IdentificationBadgeIcon, MapPinIcon,
  MegaphoneIcon, NewspaperIcon, RulerIcon, SparkleIcon, StackIcon, StarIcon, SwordIcon, UsersThreeIcon, TreeStructureIcon,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

export const SECTION_ICONS: Record<string, Icon> = {
  profile: BuildingsIcon, brief: SparkleIcon, headcount: UsersThreeIcon, departments: TreeStructureIcon, locations: MapPinIcon,
  ratings: StarIcon, leadership: IdentificationBadgeIcon, hiring: BriefcaseIcon, postings: BriefcaseIcon,
  funding: CurrencyCircleDollarIcon, traffic: ChartLineUpIcon, competitors: SwordIcon, tech: StackIcon,
  news: NewspaperIcon, posts: MegaphoneIcon, sources: RulerIcon, returns: SparkleIcon,
};

export function SectionIcon({ id, size = 18, className = "", style }: { id: string; size?: number; className?: string; style?: React.CSSProperties }) {
  const I = SECTION_ICONS[id];
  return I ? <I size={size} weight="duotone" className={className} style={style} aria-hidden /> : null;
}
