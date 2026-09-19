import { fitGazeModel, judge } from "./lib/gaze.ts";
const P=[[0.5,0.5],[0.04,0.5],[0.96,0.5],[0.5,0.05],[0.5,0.95]];
const person=(hs)=>(sx,sy)=>{const gx=sx-0.5,gy=sy-0.5;const ix=(1-hs)*gx/6,iy=(1-hs)*gy/6;
  return{ixL:ix,ixR:ix,iyL:iy,iyR:iy,yaw:hs*gx*60,pitch:hs*gy*45};};
for(const calHs of [0.0,0.5,0.75]){
  const cal=person(calHs);
  const m=fitGazeModel(P.map(([sx,sy])=>({features:cal(sx,sy),target:{sx,sy}})));
  const neutral=cal(0.5,0.5);
  for(const runHs of [0.0,0.5]){
    const run=person(runHs);
    const j=(x,y)=>{const v=judge(m,run(x,y),neutral);return v.off?v.where:"ON";};
    console.log(`cal hs=${calHs} run hs=${runHs}:  monitor-right=${j(2,0.5)}  phone-lap=${j(0.5,1.8)}  screen-corner=${j(0.02,0.95)}  centre=${j(0.5,0.5)}`);
  }
}
