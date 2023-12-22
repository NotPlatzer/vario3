import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, Dimensions, StatusBar } from 'react-native';
import MapView, { Marker, Polyline, Heatmap } from 'react-native-maps';
import * as Location from 'expo-location';
import { Barometer } from 'expo-sensors';

const delta = 0.03;

export default function App() {
  const [location, setLocation] = useState(null);
  const [lastBearing, setLastBearing] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [mapRegion, setMapRegion] = useState({
    latitude: 37.78825,
    longitude: -122.4324,
    latitudeDelta: delta, 
    longitudeDelta: delta,
  });
  const [lastThreePositions, setLastThreePositions] = useState([]);
  const [trianglePoints, setTrianglePoints] = useState([]);
  const [elevationCache, setElevationCache] = useState({});
  const searchD = 1000; //in meters
  const pointAccuracy = 4; //The number corrisponds to the level of rounding (2->1km, 3->100m, 4->10m)
  const goodHeightDiff = 100
  const [{ pressure, relativeAltitude }, setData] = useState({ pressure: 0, relativeAltitude: 0 });
  const [baroSubscription, baroSetSubscription] = useState(null);



  useEffect(() => {
    (async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Permission to access location was denied');
        return;
      }

      let locationSubscription = Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 3000,
          distanceInterval: 1,
        },
        (newLocation) => {
          console.log(newLocation)
          setLocation(newLocation);
          updateLastThreePositions(newLocation.coords);
          setMapRegion({
            latitude: newLocation.coords.latitude,
            longitude: newLocation.coords.longitude,
            latitudeDelta: delta,
            longitudeDelta: delta,
          });
        }
      );
      const baroSubscription = Barometer.addListener(({ pressure, relativeAltitude }) => {
        setData({ pressure, relativeAltitude });
      });

      return () => {
        if (locationSubscription) {
          locationSubscription.remove();
        }
        baroSubscription.remove();
      };
    })();
  }, []);

  useEffect(() => {
    if (location) {
      const bearing = calculateDirectionDegrees();
      if (bearing !== null) {
        const n1 = Math.floor(searchD / (110000 * Math.pow(10, -pointAccuracy)));
        const n2 = n1;
        const triangeData = triangleCoords(bearing, 45, searchD);
        const lenLines = triangeData[0] / 1000; // Convert to km
        const lineAngleA = triangeData[1];
        const lineAngleB = triangeData[2];
        const lineAEndPoint = calculateEndPoint(location.coords, lineAngleA, lenLines);
        const lineBEndPoint = calculateEndPoint(location.coords, lineAngleB, lenLines);
        const points = generatePointsInTriangle(location.coords, lineAEndPoint, lineBEndPoint, n1, n2);
        setTrianglePoints(points);
      }
    }
  }, [location, lastThreePositions]);

  const updateLastThreePositions = (newLocation) => {
    if (!newLocation || !newLocation.coords) {
      return;
    }

    setLastThreePositions((prevPositions) => {
      const newPositions = [
        ...prevPositions,
        {
          latitude: newLocation.coords.latitude,
          longitude: newLocation.coords.longitude,
          altitude: newLocation.coords.altitude,
          speed: newLocation.coords.speed, // Assuming speed is available in the coords object
          timestamp: newLocation.timestamp
        }
      ];
      return newPositions.slice(-3); // Keep only the last 3 positions
    });
  };


  const roundCoord = (coord) => {
    const factor = Math.pow(10, pointAccuracy);
    return Math.round(coord * factor) / factor;
  };
  const fetchElevation = async (points) => {
    const lenPoints = points.length
    const newPoints = points.filter(point => {
      const roundedPoint = `${roundCoord(point.latitude)},${roundCoord(point.longitude)}`;
      return !elevationCache.hasOwnProperty(roundedPoint);
    });
    console.log(`${lenPoints - newPoints.length} points found in cache\n${newPoints.length} points left over`)
    if (newPoints.length === 0) {
      return; // All points are already cached
    }

    const payload = {
      locations: newPoints.map(point => ({
        latitude: roundCoord(point.latitude),
        longitude: roundCoord(point.longitude)
      }))
    };

    try {
      const response = await fetch('https://api.open-elevation.com/api/v1/lookup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (data && data.results && data.results.length) {
        console.log(`API data gotten: ${data.results.length} points`)
        const newCache = { ...elevationCache };
        data.results.forEach(result => {
          const key = `${result.latitude},${result.longitude}`;
          newCache[key] = result.elevation;
        });
        setElevationCache(newCache);
      }
      else {
        console.log(`No data or unexpected format received from API: ${data}`);
      }
    } catch (error) {
      console.error('Error fetching elevation data:', error);
    }
  };

  const calculateVerticalSpeed = () => {
    if (lastThreePositions.length < 2) return 0;

    const lastPosition = lastThreePositions[lastThreePositions.length - 1];
    const secondLastPosition = lastThreePositions[lastThreePositions.length - 2];

    const altitudeChange = lastPosition.altitude - secondLastPosition.altitude;
    const timeChange = (lastPosition.timestamp - secondLastPosition.timestamp) / 1000; // convert ms to s

    if (timeChange === 0) return 0;

    return altitudeChange / timeChange; // meters per second
  };

  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    // Convert latitude and longitude from degrees to radians
    lat1 = toRadians(lat1);
    lon1 = toRadians(lon1);
    lat2 = toRadians(lat2);
    lon2 = toRadians(lon2);

    // Calculate differences
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;

    // Assuming 1 degree of latitude and longitude equals 111 km (approximate)
    const distanceLat = dLat * 111;
    const distanceLon = dLon * 111 * Math.cos((lat1 + lat2) / 2);

    // Calculate Euclidean distance
    return Math.sqrt(distanceLat * distanceLat + distanceLon * distanceLon);
  };

  const toRadians = (degree) => (degree * Math.PI) / 180;
  const toDegrees = (radian) => (radian * 180) / Math.PI;
  const pascToMeter = (pasc) => 44330 * (1 - (pasc / 1013.25) ** (1 / 5.255))
  const calcUserHeightFromPath = (horizontalSpeed, verticalSpeed, userHeight, distance) => {
    const t = distance / horizontalSpeed
    const deltaY = t * verticalSpeed
    return userHeight - deltaY
  }
  const generateRoundedPoint = (point) => {
    return {
      latitude: roundCoord(point.latitude),
      longitude: roundCoord(point.longitude),
    };
  };
  const calculateDirectionDegrees = () => {
    if (lastThreePositions.length < 2) {
      return null; // Not enough data to calculate direction
    }

    const lastPosition = lastThreePositions[lastThreePositions.length - 1];
    const secondLastPosition = lastThreePositions[lastThreePositions.length - 2];

    const lat1 = toRadians(secondLastPosition.latitude);
    const lon1 = toRadians(secondLastPosition.longitude);
    const lat2 = toRadians(lastPosition.latitude);
    const lon2 = toRadians(lastPosition.longitude);

    const dLon = lon2 - lon1;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const bearing = toDegrees(Math.atan2(y, x));
    const b = (bearing + 360) % 360;
    if (b === 0) {
      return lastBearing;
    }
    if (lastBearing !== b) {
      setLastBearing(b);
    }
    return b; // Normalize to 0-360 degrees
  };

  const calculateEndPoint = (startCoords, bearing, distance) => {
    const EarthRadius = 6371; // Radius of the earth in km
    const bearingRad = toRadians(bearing);
    const lat1 = toRadians(startCoords.latitude);
    const lon1 = toRadians(startCoords.longitude);

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance / EarthRadius) +
      Math.cos(lat1) * Math.sin(distance / EarthRadius) * Math.cos(bearingRad));
    const lon2 = lon1 + Math.atan2(Math.sin(bearingRad) * Math.sin(distance / EarthRadius) * Math.cos(lat1),
      Math.cos(distance / EarthRadius) - Math.sin(lat1) * Math.sin(lat2));

    return {
      latitude: toDegrees(lat2),
      longitude: toDegrees(lon2),
    };
  };

  function triangleCoords(bearing, searchAngle, searchDistance) {
    const lineAngleA = bearing + (searchAngle / 2);
    const lineAngleB = bearing - (searchAngle / 2);
    const lenLines = searchDistance / Math.cos(toRadians(searchAngle / 2));
    return [lenLines, lineAngleA, lineAngleB];
  }

  const interpolatePoints = (start, end, numberOfPoints) => {
    let points = [];
    for (let i = 0; i <= numberOfPoints; i++) {
      let latitude = start.latitude + (end.latitude - start.latitude) * (i / numberOfPoints);
      let longitude = start.longitude + (end.longitude - start.longitude) * (i / numberOfPoints);
      points.push({ latitude, longitude });
    }
    return points;
  };

  const generatePointsInTriangle = (userLocation, edgePoint1, edgePoint2, numberOfEdgePoints, numberOfInnerPoints) => {
    let rawPoints = [];
    const edgePoints1 = interpolatePoints(userLocation, edgePoint1, numberOfEdgePoints);
    const edgePoints2 = interpolatePoints(userLocation, edgePoint2, numberOfEdgePoints);

    for (let i = 0; i < edgePoints1.length; i++) {
      let innerPoints = interpolatePoints(edgePoints1[i], edgePoints2[i], numberOfInnerPoints);
      rawPoints.push(...innerPoints);
    }

    // Round points and remove duplicates
    const uniquePoints = new Set();
    rawPoints.forEach(point => {
      const roundedPoint = generateRoundedPoint(point);
      const key = `${roundedPoint.latitude},${roundedPoint.longitude}`;
      uniquePoints.add(key);
    });

    // Convert the set back to an array of points
    const pointsInTriangle = Array.from(uniquePoints).map(key => {
      const [latitude, longitude] = key.split(',').map(Number);
      return { latitude, longitude };
    });

    // Fetch elevation for new points
    fetchElevation(pointsInTriangle);
    return pointsInTriangle;
  };


  let text = 'Waiting..';
  let directionLine = null;
  let lineA = null;
  let lineB = null;
  if (errorMsg) {
    text = errorMsg;
  } else if (location) {
    const bearing = calculateDirectionDegrees();
    text = `Location: ${JSON.stringify(location.coords.latitude)}; ${JSON.stringify(location.coords.longitude)}\n${JSON.stringify(location.coords.altitude)}\nBearing: ${bearing ? bearing.toFixed(2) + '°' : 'Calculating...'}\nPressure: ${pressure ? pressure : 'N/A'}\nHöhe: ${pressure ? pascToMeter(pressure) : 'N/A'}`;
    if (bearing !== null) {
      const endPoint = calculateEndPoint(location.coords, bearing, 0.1); // 0.1 km ahead
      directionLine = (
        <Polyline
          coordinates={[
            { latitude: location.coords.latitude, longitude: location.coords.longitude },
            endPoint
          ]}
          strokeColor="#FF0000" // Red
          strokeWidth={3}
        />
      );
    }
  }

  const renderHeatmapFromCache = () => {
    if (!location || Object.keys(elevationCache).length === 0) {
      return null;
    }

    // Extract current user details for calculations
    const userLocation = location.coords;
    const currentAltitude = userLocation.altitude;
    const verticalSpeed = calculateVerticalSpeed(); // Current vertical speed
    const horizontalSpeed = userLocation.speed; // You'll need to implement this

    const heatmapPoints = trianglePoints.map(point => {
      const distanceToPoint = calculateDistance(userLocation.latitude, userLocation.longitude, point.latitude, point.longitude);
      const pointElevation = elevationCache[`${point.latitude},${point.longitude}`];
      const projectedUserAltitude = calcUserHeightFromPath(horizontalSpeed, verticalSpeed, currentAltitude, distanceToPoint);

      let canReach = (projectedUserAltitude - pointElevation) >= 100; // True if user is projected to be at least 100m above the point
      let normalizedHeight = canReach ? 1 : 0; // 1 if can reach, 0 otherwise

      return {
        latitude: point.latitude,
        longitude: point.longitude,
        weight: normalizedHeight, // Use this as the weight for heatmap color
      };
    });

    return (
      <Heatmap
        points={heatmapPoints}
        radius={40}
        opacity={0.7}
        gradient={{
          colors: ['red', 'green'],
          startPoints: [0, 1],
          colorMapSize: 256
        }}
      />
    );
  };


  return (
    <View style={styles.container}>
      <View style={styles.textContainer}>
        <Text>{text}</Text>
      </View>
      <MapView style={styles.map} region={mapRegion} provider='google'>
        {location && <Marker coordinate={location.coords} title="My Location" />}
        {directionLine}
        {lineA}
        {lineB}
        {Object.keys(elevationCache).length > 0 ? renderHeatmapFromCache() : null}
      </MapView>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  textContainer: {
    position: 'absolute',
    top: 50,
    left: 20,
    right: 20,
    zIndex: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    padding: 10,
    borderRadius: 10,
  },
  map: {
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height,
  },
  loadingText: {
    position: 'absolute',
    top: Dimensions.get('window').height / 2 - 10,
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    padding: 10,
    borderRadius: 10,
  },
});