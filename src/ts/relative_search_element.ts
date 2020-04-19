import { ConstraintDesc } from './taiko_types';

export class RelativeSearchElement {
  kind = 'RelativeSearchElement' as const;
  constaintDesc: ConstraintDesc;
  constructor(opts: { constaintDesc: ConstraintDesc }) {
    this.constaintDesc = opts.constaintDesc;
  }
}
export const isRelativeSearchElement = (o: any): o is RelativeSearchElement =>
  o instanceof RelativeSearchElement;
