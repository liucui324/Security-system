/**
 * map.js —— Leaflet 地图封装
 * 浏览器 GPS 为 WGS-84，高德底图为 GCJ-02：
 *   存储 / 距离计算一律使用 WGS-84，仅在显示时转换为 GCJ-02，保证打点位置与底图吻合。
 */
L.Icon.Default.imagePath = 'lib/leaflet/images/';

/* ---------- WGS-84 <-> GCJ-02（标准纠偏算法，仅中国境内生效） ---------- */
const Coord = (() => {
  const PI = Math.PI;
  const A = 6378245.0;
  const EE = 0.00669342162296594323;

  function outOfChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }
  function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }
  function wgs2gcj(wgsLng, wgsLat) {
    if (outOfChina(wgsLng, wgsLat)) return [wgsLat, wgsLng];
    let dLat = transformLat(wgsLng - 105.0, wgsLat - 35.0);
    let dLng = transformLng(wgsLng - 105.0, wgsLat - 35.0);
    const radLat = wgsLat / 180.0 * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
    return [wgsLat + dLat, wgsLng + dLng];
  }
  /** GCJ-02 转 WGS-84：迭代逼近（误差 <1e-7 度） */
  function gcj2wgs(gcjLng, gcjLat) {
    if (outOfChina(gcjLng, gcjLat)) return [gcjLat, gcjLng];
    let wgsLng = gcjLng, wgsLat = gcjLat;
    for (let i = 0; i < 8; i++) {
      const [tLat, tLng] = wgs2gcj(wgsLng, wgsLat);
      wgsLng += gcjLng - tLng;
      wgsLat += gcjLat - tLat;
    }
    return [wgsLat, wgsLng];
  }
  return {
    toMap: (lat, lng) => wgs2gcj(lng, lat),      // [latGcj, lngGcj]
    fromMap: (lat, lng) => gcj2wgs(lng, lat),    // [latWgs, lngWgs]
  };
})();

const MapUI = {
  layers() {
    const amap = L.tileLayer(
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      { subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '&copy; 高德地图' }
    );
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    });
    return { amap, osm };
  },

  /** 岗位选点地图（内部坐标为 GCJ，回调抛出 WGS-84） */
  picker(el, { lat, lng, radius, onChange }) {
    const [gLat, gLng] = Coord.toMap(lat, lng);
    const map = L.map(el).setView([gLat, gLng], 17);
    const { amap, osm } = this.layers();
    amap.addTo(map);
    L.control.layers({ '高德地图': amap, 'OpenStreetMap': osm }, {}, { position: 'topright' }).addTo(map);

    const marker = L.marker([gLat, gLng], { draggable: true }).addTo(map);
    const circle = L.circle([gLat, gLng], {
      radius,
      color: '#1d5fd0', weight: 2, fillColor: '#2f7cf6', fillOpacity: 0.1,
    }).addTo(map);

    const emitWgs = (la, ln) => {
      const [wLat, wLng] = Coord.fromMap(la, ln);
      onChange && onChange(wLat, wLng);
    };

    map.on('click', (e) => {
      marker.setLatLng(e.latlng);
      circle.setLatLng(e.latlng);
      emitWgs(e.latlng.lat, e.latlng.lng);
    });
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      emitWgs(p.lat, p.lng);
    });

    setTimeout(() => map.invalidateSize(), 60);
    return {
      setCenter: (wLat, wLng) => {
        const [la, ln] = Coord.toMap(wLat, wLng);
        marker.setLatLng([la, ln]);
        circle.setLatLng([la, ln]);
        map.panTo([la, ln]);
      },
      setRadius: (r) => circle.setRadius(r),
      invalidate: () => map.invalidateSize(),
      fit: () => map.fitBounds(circle.getBounds(), { padding: [20, 20] }),
      destroy: () => map.remove(),
    };
  },

  /** 只读查看：岗位中心+半径圈+打卡点（入参 WGS-84） */
  viewer(el, { postLat, postLng, radius, pointLat, pointLng }) {
    const [pLat, pLng] = Coord.toMap(postLat, postLng);
    const map = L.map(el).setView([pLat, pLng], 16);
    const { amap, osm } = this.layers();
    amap.addTo(map);
    L.control.layers({ '高德地图': amap, 'OpenStreetMap': osm }, {}, { position: 'topright' }).addTo(map);

    L.circle([pLat, pLng], {
      radius, color: '#1d5fd0', weight: 2, fillColor: '#2f7cf6', fillOpacity: 0.1,
    }).addTo(map);
    L.marker([pLat, pLng]).addTo(map).bindTooltip('岗位中心');

    const bounds = L.latLngBounds([[pLat, pLng]]);
    if (pointLat != null) {
      const [qLat, qLng] = Coord.toMap(pointLat, pointLng);
      L.circleMarker([qLat, qLng], {
        radius: 8, color: '#fff', weight: 2, fillColor: '#e5484d', fillOpacity: 1,
      }).addTo(map).bindTooltip('打卡位置');
      bounds.extend([qLat, qLng]);
    }
    map.fitBounds(bounds.pad(0.4));
    setTimeout(() => map.invalidateSize(), 60);
    return { invalidate: () => map.invalidateSize(), destroy: () => map.remove() };
  },
};
