"use strict"

const moduleConfig = require('conf/moduleConfig.js');
const TimeoutPromise = require('utils/timeoutPromise.js')
const baseChain = require("chain/base.js");

const { Api, JsonRpc, RpcError } = require('eosjs');
const fetch = require('node-fetch');
const { TextEncoder, TextDecoder } = require('util');

function sleep(time) {
  return new Promise(function(resolve, reject) {
    setTimeout(function() {
      resolve();
    }, time);
  })
}

class EosChain extends baseChain {
  constructor(log, nodeUrl) {
    super(log, nodeUrl);
  }

  setChainType() {
    this.chainType = 'EOS';
  }

  getClient(nodeUrl) {
    if (nodeUrl.indexOf("http://") !== -1 || nodeUrl.indexOf("https://") !== -1) {
      this.nodeUrl = nodeUrl;
      const rpc = new JsonRpc(nodeUrl, { fetch });
      const api = new Api({ rpc, authorityProvider: rpc, textDecoder: new TextDecoder(), textEncoder: new TextEncoder() });

      return api;
    } else {
      return null;
    }
  }

  async get_info() {
    let eos = this.client;
    let log = this.log;
    let chainType = this.chainType;

    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let result = await eos.rpc.get_info();
        log.debug("ChainType:", chainType, "get_info result is", result);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' get_info timeout')
  }

  getNetworkId() {
    let log = this.log;
    let chainType = this.chainType;
    let eos = this.client;
    let self = this;

    return new TimeoutPromise(async (resolve, reject)=> {
      try {
        if (self.chainId) {
          resolve(self.chainId);
          return;
        }
        let chain_info = await eos.rpc.get_info();
        let chain_id = chain_info.chain_id;
        log.debug("ChainType:", chainType, "getNetWork result is", chain_id);
        self.chainId = chain_id;
        resolve(chain_id);
      } catch (err) {
        reject(err);
      };
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getNetworkId timeout');
  }

  encodeToken(account, quantity) {
    let symbol = quantity.split(' ')[1];
    // let decimals = quantity.split(' ')[0].split('.')[1] ? quantity.split(' ')[0].split('.')[1].length : 0;
    return account + ':' + symbol;
  }

  encodeTokenWithSymbol(account, symbol) {
    return account + ':' + symbol;
  }

  actionDecode(actions) {
    let self = this;
    let log = this.log;
    let chainType = this.chainType;
    const trx = [];
    actions.map(action => {
      try{
        let act = action.hasOwnProperty('action_trace') ? action.action_trace.act : action.act;
        const { account, name, authorization, data } = act;
        let date = new Date(action.block_time + 'Z'); // "Z" is a zero time offset
        let obj = {
          address: account,
          blockNumber: action.block_num,
          transactionHash: action.hasOwnProperty('action_trace') ? action.action_trace.trx_id : action.trx_id,
          authorization: authorization,
          timestamp: date.getTime()/1000,
          event: name
        }
        if (name === moduleConfig.crossInfoDict[this.chainType].TOKEN.depositAction[0]) {
          if (act.data.memo.split(':').length === 5 && act.data.memo.split(':')[0] === 'inlock') {
            // const { from, to, quantity, memo } = act.data;
            const { from, to, quantity, memo, amount, symbol } = act.data;
            obj = {
              ...obj,
              args: {
                user: from,
                toHtlcAddr: to,
                storeman: '0x' + memo.split(':')[3],
                xHash: '0x' + memo.split(':')[1],
                wanAddr: '0x' + memo.split(':')[2],
              }
            };
            if (quantity) {
              obj.args.value = quantity;
              obj.args.tokenOrigAccount = self.encodeToken(account, quantity);
            } else if (amount) {
              obj.args.value = amount.toString();
              obj.args.tokenOrigAccount = self.encodeTokenWithSymbol(account, symbol);
            }
          } else if (global.argv.leader && act.data.memo.split(':').length === 1 && act.data.memo.split(':')[0] === moduleConfig.crossInfoDict[this.chainType].TOKEN.withdrawFeeAction) {
            obj.event = act.data.memo;
            obj = {
              ...obj,
              args: data
            }
          } else {
            return;
          }
        } else {
          if (data) {
            // if (data.value) {
            //   data.value = this.toFloat(data.value);
            // };
            if (data.xHash) {
              data.xHash = '0x' + data.xHash;
            };
            if (data.x) {
              data.x = '0x' + data.x;
            };
            if (data.quantity) {
              data.value = data.quantity;
            };
            if (data.amount) {
              data.value = data.amount;
            };
            // if (data.npk) {
            //   data.storeman = '0x' + data.npk;
            // };
            obj = {
              ...obj,
              args: data
            };
          } else {
            return;
          }
        }
        trx.push(obj);
      } catch (err) {
        log.error("ChainType:", chainType, "something wrong happened during actionDecode", err, actions);
      }
    })
    return trx;
  }

  getScEventSync(accountName, topics, fromBlk, toBlk, retryTimes = 0) {
    let times = 0;
    let chainType = this.chainType;
    let log = this.log;
    let eos = this.client;
    let self = this;
    return new TimeoutPromise(async function (resolve, reject) {
      let filterFunc = [];
      filterFunc = filterFunc.concat(moduleConfig.crossInfoDict[chainType].TOKEN.depositAction,
        moduleConfig.crossInfoDict[chainType].TOKEN.withdrawAction,
        // moduleConfig.crossInfoDict[chainType].TOKEN.withdrawFeeAction, // withdrawFee will in eosio.token inline action
        moduleConfig.crossInfoDict[chainType].TOKEN.debtAction);
      let filter = action => (action.hasOwnProperty('action_trace') && action.block_num >= fromBlk && action.block_num <= toBlk && (filterFunc.includes(action.action_trace.act.name))) ||
                            (action.hasOwnProperty('act') && action.block_num >= fromBlk && action.block_num <= toBlk && (filterFunc.includes(action.act.name)));

      let filterGet = async function (filter) {
        try {
          let result = await eos.rpc.history_get_actions(accountName);
          let actions = result.actions.filter(filter);
          const trx = self.actionDecode(actions);
          resolve(trx);
        } catch (err) {
          if (times >= retryTimes) {
            log.error("ChainType:", chainType, "getScEventSync", err);
            reject(err);
          } else {
            log.debug("ChainType:", chainType, "getScEventSync retry", times);
            times++;
            filterGet(filter);
          }
        }
      }
      try {
        filterGet(filter);
      } catch (err) {
        log.error("ChainType:", chainType, "getScEventSync", err);
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getScEventSync timeout');
  }

  getBlockNumberSync() {
    let chainType = this.chainType;
    let eos = this.client;
    let self = this;
    let log = this.log;
    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let result = await eos.rpc.get_info();
        let blockNumber = result.head_block_num;
        log.debug("ChainType:", chainType, 'getBlockNumberSync successfully with result: ', self.chainType, blockNumber);
        resolve(blockNumber);
      } catch (err) {
        reject(err);
      };
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getBlockNumberSync timeout')
  }

  getIrreversibleBlockNumberSync() {
    let chainType = this.chainType;
    let eos = this.client;
    let self = this;
    let log = this.log;
    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let result = await eos.rpc.get_info();
        let blockNumber = result.last_irreversible_block_num;
        log.debug("ChainType:", chainType, 'getIrreversibleBlockNumberSync successfully with result: ', self.chainType, blockNumber);
        resolve(blockNumber);
      } catch (err) {
        reject(err);
      };
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getIrreversibleBlockNumberSync timeout')
  }

  async getBlockByNumber(blockNumber, callback) {
    let eos = this.client;
    try {
      let result = await eos.rpc.get_block(blockNumber);
      let date = new Date(result.timestamp + 'Z'); // "Z" is a zero time offset
      result.timestamp = date.getTime()/1000;
      callback(null, result);
    } catch (err) {
      callback(err, null);
    }
  }

  getBlockByNumberSync(blockNumber) {
    let eos = this.client;
    let chainType = this.chainType;

    return new TimeoutPromise(async function (resolve, reject) {
      try {
        let result = await eos.rpc.get_block(blockNumber);
        let date = new Date(result.timestamp + 'Z'); // "Z" is a zero time offset
        result.timestamp = date.getTime()/1000;
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getBlockByNumberSync timeout');
  }

  getTransactionReceiptSync(txHash, block_num) {
    let chainType = this.chainType;
    let eos = this.client;
    
    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let result = await eos.rpc.history_get_transaction(txHash, block_num);
        if (result && result.error) {
          reject(result.error);
        } else {
          resolve(result);
        }
      } catch (err) {
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getTransactionReceiptSync timeout')
  }
  
  getTransactionConfirmSync(txHash, waitBlocks, block_num) {
    let chainType = this.chainType;
    let log = this.log;
    let self = this;
    let eos = this.client;
    let receipt = null;
    let curBlockNum = 0;
    let sleepTime = 30;
    let last_irreversible_block_num;
    let chain_info;

    return new TimeoutPromise(async (resolve, reject) => {
      try {
        receipt = await self.getTransactionReceiptSync(txHash, block_num);
        if (receipt === null) {
          resolve(receipt);
          return;
        }

        chain_info = await eos.rpc.get_info();
        last_irreversible_block_num = chain_info.last_irreversible_block_num;
        curBlockNum = chain_info.head_block_num;
        let receiptBlockNumber = receipt.block_num;

        while (receiptBlockNumber + waitBlocks > curBlockNum || receiptBlockNumber > last_irreversible_block_num) {
          log.debug("ChainType:", chainType, "getTransactionConfirmSync was called at block: ", receipt.block_num, 'curBlockNumber is ', curBlockNum, 'while ConfirmBlocks should after about block', waitBlocks, ', wait some time to re-get',
          "while last_irreversible_block_num is ", last_irreversible_block_num);
          await sleep(sleepTime * 1000);
          receipt = await self.getTransactionReceiptSync(txHash, block_num);

          chain_info = await eos.rpc.get_info();
          last_irreversible_block_num = chain_info.last_irreversible_block_num;
          curBlockNum = chain_info.head_block_num;
          receiptBlockNumber = receipt.block_num;
        }
        if (receipt.trx.receipt.status === 'executed') {
          receipt.status = '0x1';
        }
        resolve(receipt);
      } catch (err) {
        reject(err);
        // resolve(null);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getTransactionConfirmSync timeout')
  }

  checkTransIrreversibleSync(txHash) {
    let chainType = this.chainType;
    let log = this.log;
    let self = this;
    let eos = this.client;
    let receipt = null;

    return new TimeoutPromise(async (resolve, reject) => {
      try {
        receipt = await self.getTransactionReceiptSync(txHash);
        if (receipt === null) {
          reject('something is wrong while checkTransIrreversibleSync, the trans is not found' + txHash);
          return;
        }

        let chain_info = await eos.rpc.get_info();
        if (receipt.block_num <= chain_info.last_irreversible_block_num) {
          resolve(true);
        } else {
          log.debug("ChainType:", chainType, "checkTransIrreversibleSync was called for txHash: ", txHash, 'on block', receipt.block_num,
          "while last_irreversible_block_num is ", chain_info.last_irreversible_block_num, ', wait some time to re-check');
          resolve(false);
        }
      } catch (err) {
        reject('something is wrong while checkTransIrreversibleSync:' + err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' checkTransIrreversibleSync timeout')
  }

  async packTrans(actions) {
    let chainType = this.chainType;
    let eos = this.client;

    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let trans = {
          actions: actions
        }
        let packed_tx = await eos.transact(trans, {
          blocksBehind: 3,
          expireSeconds: 30,
          broadcast: false,
          sign: false
        });
  
        console.log("packed_tx is", JSON.stringify(packed_tx, null, 4));
        resolve (packed_tx);
      } catch (err) {
        reject(new Error(err));
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' packTrans timeout')   
  }

  async serializeActions(actions) {
    let chainType = this.chainType;
    let eos = this.client;

    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let result = await eos.serializeActions(actions);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' serializeActions timeout')
  }

  async serializeTransaction(trans) {
    let chainType = this.chainType;
    let eos = this.client;

    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let result = await eos.serializeTransaction(trans);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' serializeTransaction timeout')
  }

  async get_rawabi_and_abi(account) {
    let chainType = this.chainType;

    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let eos = this.client;

        let rawAbi = (await eos.abiProvider.getRawAbi(account)).abi;
        let abi = (await eos.abiProvider.get_abi(account)).abi;
        console.log("==================get_rawabi_and_abi==================");
        console.log(rawAbi);
        console.log(abi);

        let result = {
          accountName: account,
          rawAbi: rawAbi,
          abi: abi
        }
        resolve(result);
      } catch (err) {
        console.log(err);
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' get_rawabi_and_abi timeout')
  }

  async getRequiredKeys(transaction, available_keys) {
    let chainType = this.chainType;
    let eos = this.client;
    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let result = await eos.rpc.getRequiredKeys({transaction: transaction, availableKeys: available_keys});
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getRequiredKeys timeout')
  }

  async sendRawTransaction(signedTx, callback) {
    let log = this.log;
    let chainType = this.chainType;
    try {
      let nodeUrl = global.config.crossTokens[chainType].CONF.bpNodeUrl;
      const rpc = new JsonRpc(nodeUrl, { fetch });
      const api = new Api({ rpc, authorityProvider: rpc, textDecoder: new TextDecoder(), textEncoder: new TextEncoder() });
      let eos = this.client;
      eos = api;
      let result = await eos.pushSignedTransaction(signedTx);
      log.debug("sendRawTransaction result is", nodeUrl, result);
      callback(null, result);
    } catch (err) {
      callback(err, null);
    }
  }

  async sendRawTransactionSync(signedTx) {
    let log = this.log;
    let chainType = this.chainType;
    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let nodeUrl = global.config.crossTokens[chainType].CONF.bpNodeUrl;
        const rpc = new JsonRpc(nodeUrl, { fetch });
        const api = new Api({ rpc, authorityProvider: rpc, textDecoder: new TextDecoder(), textEncoder: new TextEncoder() });
        let eos = this.client;
        eos = api;
        let result = await eos.pushSignedTransaction(signedTx);
        log.debug("sendRawTransactionSync result is", nodeUrl, result)
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' sendRawTransactionSync timeout')
  }

  async getTableRows(scAddr, scope, table) {
    let chainType = this.chainType;
    let eos = this.client;

    let tableParams = {
      json: true,
      code: undefined,
      scope: undefined,
      table: undefined,
      table_key: '',
      lower_bound: '',
      upper_bound: '',
      index_position: 1,
      key_type: '',
      limit: 10,
      reverse: false,
      show_payer: false
    };
    let args = Object.assign({}, tableParams);
    args.code = scAddr;
    args.scope = scope;
    args.table = table;

    return new TimeoutPromise(async (resolve, reject) => {
      try {
        /*
        * Result:
        * {
        *   rows:[{xxx},{xxx}]
        *   more:false
        * }
        */
        let result = await eos.rpc.get_table_rows(args);
        resolve(result.rows);
      } catch (err) {
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getTableRows timeout')
  }

  async getTokenStoremanFee(crossChain, tokenType, tokenOrigAddr, smgAddress) {
    let chainType = this.chainType;

    return new TimeoutPromise(async (resolve, reject) => {
      try {
        let htlcAddr = moduleConfig.crossInfoDict[crossChain][tokenType].originalChainHtlcAddr;
        let pks = await this.getTableRows(htlcAddr, htlcAddr, 'pks');
        let pkId = null;
        for (let id in pks) {
          if (pks[id].pk === smgAddress) {
            pkId = pks[id].id;
            break;
          }
        }

        if (pkId === null) {
          reject('storemanPk is not found', smgAddress);
        } else {
          let fees = await this.getTableRows(htlcAddr, pkId, 'fees');
          let feeBalance = 0;
          for (let fee of fees) {
            if (this.encodeToken(fee.account, fee.fee) === tokenOrigAddr) {
              feeBalance = fee.fee;
              break;
            }
          }
          resolve(feeBalance);
        }
      } catch (err) {
        reject(err);
      }
    }, moduleConfig.promiseTimeout, "ChainType: " + chainType + ' getTokenStoremanFee timeout');
  }

}

module.exports = EosChain;
