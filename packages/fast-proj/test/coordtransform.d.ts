declare module 'coordtransform' {
  const coordtransform: {
    wgs84togcj02(lon: number, lat: number): [number, number];
    gcj02towgs84(lon: number, lat: number): [number, number];
    gcj02tobd09(lon: number, lat: number): [number, number];
    bd09togcj02(lon: number, lat: number): [number, number];
  };
  export default coordtransform;
}
