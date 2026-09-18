declare module "snarkjs" {
  export namespace curves {
    function getCurveFromName(name: string, singleThread?: boolean): Promise<{ terminate(): Promise<void> }>;
  }
}
