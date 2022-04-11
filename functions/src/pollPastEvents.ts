import * as functions from "firebase-functions";
import corsLib from "cors";
import * as firebaseAdmin from "firebase-admin";
import {Contract, EventData} from "web3-eth-contract";
import Web3 from "web3";
import fetch from "node-fetch";

// CONSTANTS
const ETHERSCAN_URL = "http://api-rinkeby.etherscan.io/";
const ETHERSCAN_API_KEY = "[YOUR API KEY]";
const CONTRACT_ADDRESS = "0x31F57270cb0Ec487BB7950d4465cdfAFaD505ecB";
const INFURA_ROOT_URL = "https://rinkeby.infura.io/v3/";
const INFURA_PROJECT_ID = "[YOUR INFURA KEY]";
//

export type ObjectMap = {[key: string]: any}

const cors = corsLib({
  origin: true,
});

const admin = firebaseAdmin.initializeApp();

const getContract = async (
    web3: Web3
): Promise<Contract> => {
  const etherscanURL = `${ETHERSCAN_URL}api?module=contract&action=getabi&address=${CONTRACT_ADDRESS}&apikey=${ETHERSCAN_API_KEY}`;

  const etherscanResponse = await fetch(etherscanURL);
  const etherscanContractData = await etherscanResponse.json();

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return new web3.eth.Contract(JSON.parse(etherscanContractData.result), CONTRACT_ADDRESS);
};


const parseObject = (obj: ObjectMap): ObjectMap => {
  const res: ObjectMap = { };

  // Parse the event to be Firestore compatible
  // Convert the nested arrays for adminMods and addrStates
  // into mappings
  Object.keys(obj).forEach((key) => {
    // 1.
    if (typeof obj[key] === "object") {
      if (key === "adminMods") {
        const adminMods: ObjectMap = {};

        obj[key].map((e: string[]) => {
          // Convert 0/1 string to bool
          adminMods[e[0]] = e[1] === "1";
        });

        res[key] = adminMods;
      } else if (key === "addrStates") {
        const addrStates: ObjectMap = {};

        obj[key].map((e: string[]) => {
          // Convert value string to int
          addrStates[e[0]] = Number(e[1]);
        });

        res[key] = addrStates;
      } else {
        // 2.
        res[key] = parseObject(obj[key]);
      }
    } else if (key === "id") {
      // 3.
      if (isNaN(Number(obj[key]))) {
        res[key] = obj[key];
      } else {
        res[key] = `0x${BigInt(obj[key]).toString(16)}`;
      }
    } else {
      // 4.
      res[key] = obj[key];
    }
  });

  return res;
};

const addEventsToArchive = async (events: EventData[]) => {
  try {
    if (events.length > 0) {
      events.map((e) => {
        const res = parseObject(e);

        admin
            .firestore()
            .collection("events")
            .doc("rinkeby")
            .collection("archive") // Store in subcollection 'archive'
            .doc(e.transactionHash)
            .set(res)
            .then(() => console.log(`Event written: ${e.transactionHash}`))
            .catch((err) => {
              console.log(`Error for ${e.transactionHash} - ${err}`);
            });
      });
    }
  } catch (err) {
    console.error(err);
  }
};

const getPastEvents = async () => {
  try {
    // Get lastBlockProcessed from Firestore
    const eventsDoc = await admin
        .firestore()
        .collection("events")
        .doc("rinkeby")
        .get();


    // Check that the document has data
    if (eventsDoc.exists && eventsDoc.data()) {
      const data = eventsDoc.data();
      const lastBlockProcessed = data?.lastBlockProcessed;

      if (lastBlockProcessed) {
        const startBlock = lastBlockProcessed+1;
        const endBlock = startBlock + 100; // Modify the range to your needs

        const web3 = new Web3(
            new Web3.providers.HttpProvider(
                INFURA_ROOT_URL + INFURA_PROJECT_ID
            )
        );

        // Fetch contract from Etherscan
        const contract = await getContract(web3);

        // Fetch past events starting from the last block we processed
        const events = await contract.getPastEvents("allEvents",
            {
              fromBlock: startBlock,
              toBlock: endBlock, // can also use 'latest'
            });

        addEventsToArchive(events);

        const currentBlockNumber = await web3.eth.getBlockNumber();

        const lastBlockSeen =
          endBlock > currentBlockNumber ? currentBlockNumber : endBlock;

        // Update lastBlockProcessed in Firestore
        await admin
            .firestore()
            .collection("events")
            .doc("rinkeby")
            .update({
              lastBlockProcessed: lastBlockSeen,
            });
      }
    }
  } catch (err) {
    console.error(err);
  }
  return null;
};

// Cron job that runs internal function
export const pollPastEvents = functions.pubsub.schedule("every 1 minutes").onRun(async () => {
  await getPastEvents();
  return null;
});

// HTTP endpoint to quickly test internal business logic
export const httpPastEvents = functions.https.onRequest(
    (request, response) => {
      cors(request, response, async () => {
        await getPastEvents();
        return response.status(200).json();
      });
    }
);
